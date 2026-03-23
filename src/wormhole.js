/**
 * Wormhole-nym protocol state machines for browser use.
 *
 * receiveFile(code, nymClient, callbacks)  — side B (receiver)
 * sendFile(file, nymClient, callbacks)     — side A (sender)
 *
 * Both use rawSend / subscribeToRawMessageReceivedEvent for binary
 * compatibility with the wormhole-nym CLI (send_plain_message / next().await).
 *
 * Message flow (matches receive.rs / send.rs exactly):
 *
 *  Receiver ──Hello{addr, B_pake}─────────────────────────────► Sender
 *  Receiver ◄──PakeReply{A_pake}──────────────────────────────── Sender
 *  Receiver ──Ready───────────────────────────────────────────► Sender
 *  Receiver ◄──Encrypted(0, Offer{filename,size,sha256})──────── Sender
 *  Receiver ──Encrypted(0, Accept)────────────────────────────► Sender
 *  Receiver ◄──Encrypted(1..N, Chunk{seq,data}) × N────────────── Sender  [ARQ]
 *  Receiver ◄──Encrypted(N+1, Done{total_chunks})─────────────── Sender
 *  Receiver ──Encrypted(1.., Ack{sha256})─────────────────────► Sender
 */

import { encodeMsg, decodeMsg, sealMsg, openMsg } from './protocol.js';
import { deriveKeys, sha256Hash, bytesEqual }      from './crypto.js';
import {
  spake2StartSender, spake2FinishSender,
  spake2StartReceiver, spake2FinishReceiver,
} from './spake2.js';
import { generatePassword } from './words.js';

const CHUNK_SIZE = 32 * 1024; // 32 KiB — matches CLI

// ── Helpers ───────────────────────────────────────────────────────────────────

async function rawSend(nymClient, recipient, bytes, onPacketSent) {
  await nymClient.client.rawSend({ payload: bytes, recipient });
  onPacketSent?.();
}

/** Increment a BigInt counter and return the old value (post-increment semantics). */
function ctrNext(ref) {
  const old = ref.v;
  ref.v += 1n;
  return old;
}

// ── Simple async queue ────────────────────────────────────────────────────────

class Queue {
  #items = [];
  #waiter = null;

  push(item) {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ ok: item });
    } else {
      this.#items.push(item);
    }
  }

  drain() {
    const all = this.#items.splice(0);
    return all;
  }

  /** Resolves to { ok } or throws on timeout. */
  next(timeoutMs = 60_000) {
    if (this.#items.length > 0) {
      return Promise.resolve({ ok: this.#items.shift() });
    }
    return new Promise((resolve, reject) => {
      this.#waiter = resolve;
      setTimeout(() => {
        if (this.#waiter === resolve) {
          this.#waiter = null;
          reject(new Error('Timeout waiting for message'));
        }
      }, timeoutMs);
    });
  }
}

// ── Reorder buffer ─────────────────────────────────────────────────────────────
// Nym mixnet may reorder packets. Buffer by counter, yield in order.

class PayloadBuffer {
  #buf  = new Map();   // BigInt counter → Payload
  #next = 0n;
  #ready = [];         // in-order, ready-to-consume payloads
  #waiter = null;
  #errorWaiter = null;

  /**
   * Feed an already-parsed Msg::Encrypted, decrypt and buffer.
   * key: the sendKey of whoever is sending these messages.
   */
  feed(key, encMsg) {
    let payload;
    try {
      payload = openMsg(key, encMsg);
    } catch (e) {
      console.warn('Decryption failed:', e);
      return;
    }
    this.#buf.set(encMsg.counter, payload);
    this.#drain();
  }

  #drain() {
    while (this.#buf.has(this.#next)) {
      const p = this.#buf.get(this.#next);
      this.#buf.delete(this.#next);
      this.#next += 1n;
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = null;
        w({ ok: p });
      } else {
        this.#ready.push(p);
      }
    }
  }

  /** True if the buffer holds out-of-order messages but the next expected is missing. */
  hasMissing() {
    return this.#buf.size > 0 && !this.#buf.has(this.#next);
  }

  nextExpected() { return this.#next; }

  /** Returns the next in-order payload, or throws on timeout. */
  async nextPayload(timeoutMs = 30_000) {
    if (this.#ready.length > 0) return this.#ready.shift();
    return new Promise((resolve, reject) => {
      this.#waiter = resolve;
      setTimeout(() => {
        if (this.#waiter === resolve) {
          this.#waiter = null;
          reject(new Error('Timeout waiting for payload'));
        }
      }, timeoutMs);
    }).then(({ ok }) => ok);
  }
}

// ── RECEIVE (web = wormhole-nym receiver / SPAKE2 side B) ─────────────────────

/**
 * Download a file from a wormhole-nym sender (CLI or web).
 *
 * callbacks:
 *   onStatus(text)             — human-readable status string
 *   onOffer(offer)             — called with { filename, filesize }; must return Promise<bool>
 *   onProgress(received, total)— BigInts
 *   onComplete(filename, blob) — transfer finished, browser download triggered by caller
 */
export async function receiveFile(code, nymClient, callbacks) {
  const { onStatus, onOffer, onProgress, onComplete, onPacketSent, onPacketReceived } = callbacks;
  let unsub = null;

  try {
    // ── Parse code ────────────────────────────────────────────────────────────
    const colon = code.indexOf(':');
    if (colon < 1) throw new Error('Invalid wormhole code — expected "word-word-word:NymAddress"');
    const password   = code.slice(0, colon).trim();
    const senderAddr = code.slice(colon + 1).trim();
    if (!senderAddr) throw new Error('Invalid wormhole code — missing Nym address after colon');
    const pwBytes = new TextEncoder().encode(password);

    // ── SPAKE2 start ──────────────────────────────────────────────────────────
    onStatus('Starting SPAKE2 key exchange…');
    const spakeState = spake2StartReceiver(pwBytes);
    const ourAddr    = await nymClient.client.selfAddress();

    // ── Single message router (raw bytes → Queue or PayloadBuffer) ────────────
    // We use ONE subscription the whole time and route based on state.
    const rawQ  = new Queue();       // for pre-key messages (PakeReply)
    const payBuf = new PayloadBuffer(); // for post-key encrypted payloads
    let keysReady = false;
    let sendKey   = null;

    unsub = nymClient.events.subscribeToRawMessageReceivedEvent(e => {
      onPacketReceived?.();
      const bytes = e.args.payload;
      if (!keysReady) {
        // Only accept PakeReply in the pre-key phase.
        // This prevents cross-talk when sender and receiver share the same client:
        // the Hello we sent bounces back to us too, but we must not consume it.
        try {
          const msg = decodeMsg(bytes);
          if (msg.type === 'PakeReply') rawQ.push(bytes);
        } catch { /* ignore malformed */ }
      } else {
        // Route to PayloadBuffer
        try {
          const msg = decodeMsg(bytes);
          if (msg.type === 'Encrypted') payBuf.feed(sendKey, msg);
        } catch { /* ignore malformed */ }
      }
    });

    // ── Send Hello ────────────────────────────────────────────────────────────
    await rawSend(nymClient, senderAddr, encodeMsg({
      type: 'Hello',
      receiver_address: ourAddr,
      pake_msg: spakeState.msg,
    }), onPacketSent);

    onStatus('Waiting for sender SPAKE2 reply…');

    // ── Wait for PakeReply ────────────────────────────────────────────────────
    let pakeReplyMsg;
    {
      const { ok } = await rawQ.next(60_000);
      pakeReplyMsg = decodeMsg(ok);
    }
    if (pakeReplyMsg.type !== 'PakeReply')
      throw new Error(`Expected PakeReply, got ${pakeReplyMsg.type}`);

    // ── Complete SPAKE2, derive keys ──────────────────────────────────────────
    const secret = spake2FinishReceiver(spakeState, pakeReplyMsg.pake_msg, pwBytes);
    const keys   = deriveKeys(secret);
    sendKey = keys.sendKey;
    const recvKey = keys.recvKey;
    const recvCtr = { v: 0n };

    // Flush any messages that sneaked into rawQ before we flipped the flag
    const flushed = rawQ.drain();
    keysReady = true;  // from now on router feeds payBuf
    for (const bytes of flushed) {
      try {
        const msg = decodeMsg(bytes);
        if (msg.type === 'Encrypted') payBuf.feed(sendKey, msg);
      } catch { /* ignore */ }
    }

    onStatus('Key exchange complete. Sending Ready…');

    // ── Send Ready ────────────────────────────────────────────────────────────
    await rawSend(nymClient, senderAddr, encodeMsg({ type: 'Ready' }), onPacketSent);

    onStatus('Waiting for file offer…');

    // ── Receive Offer ─────────────────────────────────────────────────────────
    const offer = await payBuf.nextPayload(60_000);
    if (offer.type !== 'Offer')
      throw new Error(`Expected Offer, got ${offer.type}`);

    // ── Ask user ──────────────────────────────────────────────────────────────
    const accepted = await onOffer({
      filename: offer.filename,
      filesize: offer.filesize,
    });

    if (!accepted) {
      await rawSend(nymClient, senderAddr,
        sealMsg(recvKey, ctrNext(recvCtr), { type: 'Reject', reason: 'User declined' }), onPacketSent);
      onStatus('Transfer rejected.');
      return;
    }

    // ── Send Accept ───────────────────────────────────────────────────────────
    await rawSend(nymClient, senderAddr,
      sealMsg(recvKey, ctrNext(recvCtr), { type: 'Accept' }), onPacketSent);
    onStatus('Receiving file…');

    // ── Receive chunks ────────────────────────────────────────────────────────
    const chunkMap  = new Map();  // seq (BigInt) → Uint8Array
    let totalChunks = null;       // BigInt once Done received
    let bytesReceived = 0n;
    const filesize    = offer.filesize;
    let lastRetransmitMs = 0;
    const RT_COOLDOWN = 3_000;

    while (totalChunks === null || BigInt(chunkMap.size) < totalChunks) {
      let payload;
      try {
        payload = await payBuf.nextPayload(30_000);
      } catch {
        // Timeout — request retransmit if there's a gap
        const now = Date.now();
        if (payBuf.hasMissing() && now - lastRetransmitMs > RT_COOLDOWN) {
          lastRetransmitMs = now;
          const missing = payBuf.nextExpected();
          onStatus(`Gap detected, requesting retransmit of slot ${missing}…`);
          await rawSend(nymClient, senderAddr,
            sealMsg(recvKey, ctrNext(recvCtr), { type: 'Retransmit', counter: missing }), onPacketSent);
        }
        continue;
      }

      if (payload.type === 'Chunk') {
        if (!chunkMap.has(payload.seq)) {
          chunkMap.set(payload.seq, payload.data);
          bytesReceived += BigInt(payload.data.length);
          onProgress(bytesReceived, filesize);
        }
      } else if (payload.type === 'Done') {
        totalChunks = payload.total_chunks;
      } else if (payload.type === 'Error') {
        throw new Error(`Sender error: ${payload.message}`);
      }
    }

    onStatus('Verifying file integrity…');

    // ── Assemble & verify ─────────────────────────────────────────────────────
    const fileData = new Uint8Array(Number(filesize));
    let offset = 0;
    for (let seq = 0n; seq < totalChunks; seq++) {
      const chunk = chunkMap.get(seq);
      if (!chunk) throw new Error(`Missing chunk ${seq} after all chunks received`);
      fileData.set(chunk, offset);
      offset += chunk.length;
    }

    const computedHash = sha256Hash(fileData);
    if (!bytesEqual(computedHash, offer.sha256))
      throw new Error('File integrity check failed (SHA-256 mismatch). File may be corrupted.');

    // ── Send Ack ──────────────────────────────────────────────────────────────
    await rawSend(nymClient, senderAddr,
      sealMsg(recvKey, ctrNext(recvCtr), { type: 'Ack', sha256: computedHash }), onPacketSent);

    onStatus('Transfer complete!');
    onComplete(offer.filename, new Blob([fileData]));

  } finally {
    if (unsub) unsub();
  }
}

// ── SEND (web = wormhole-nym sender / SPAKE2 side A) ─────────────────────────

/**
 * Send a file to a wormhole-nym receiver (CLI or web).
 *
 * callbacks:
 *   onCode(code)               — called with "word-word-word:NymAddress" to share
 *   onStatus(text)             — human-readable status
 *   onProgress(sent, total)    — BigInts
 *   onComplete()               — receiver confirmed receipt
 */
export async function sendFile(file, nymClient, callbacks) {
  const { onCode, onStatus, onProgress, onComplete, onPacketSent, onPacketReceived } = callbacks;
  let unsub = null;

  try {
    onStatus('Computing SHA-256 hash of file…');

    // ── Read & hash file ──────────────────────────────────────────────────────
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const fileHash  = sha256Hash(fileBytes);

    // ── Generate wormhole code ────────────────────────────────────────────────
    const password = generatePassword(3);
    const pwBytes  = new TextEncoder().encode(password);
    const ourAddr  = await nymClient.client.selfAddress();
    onCode(`${password}:${ourAddr}`);

    onStatus('Waiting for receiver to connect (keep this page open)…');

    // ── SPAKE2 start ──────────────────────────────────────────────────────────
    const spakeState = spake2StartSender(pwBytes);

    // ── Message router ────────────────────────────────────────────────────────
    const rawQ   = new Queue();
    const payBuf = new PayloadBuffer();
    let keysReady = false;
    let recvKey   = null;

    unsub = nymClient.events.subscribeToRawMessageReceivedEvent(e => {
      onPacketReceived?.();
      const bytes = e.args.payload;
      if (!keysReady) {
        // Only accept Hello in the pre-key phase.
        // Prevents cross-talk when sender and receiver share the same client.
        try {
          const msg = decodeMsg(bytes);
          if (msg.type === 'Hello') rawQ.push(bytes);
        } catch { /* ignore malformed */ }
      } else {
        try {
          const msg = decodeMsg(bytes);
          if (msg.type === 'Encrypted') payBuf.feed(recvKey, msg);
        } catch { /* ignore */ }
      }
    });

    // ── Wait for Hello ────────────────────────────────────────────────────────
    const { ok: helloBytes } = await rawQ.next(600_000); // 10 min for receiver
    const helloMsg = decodeMsg(helloBytes);
    if (helloMsg.type !== 'Hello')
      throw new Error(`Expected Hello, got ${helloMsg.type}`);

    const receiverAddr = helloMsg.receiver_address;
    onStatus('Receiver connected. Completing key exchange…');

    // ── Send PakeReply ────────────────────────────────────────────────────────
    await rawSend(nymClient, receiverAddr,
      encodeMsg({ type: 'PakeReply', pake_msg: spakeState.msg }), onPacketSent);

    // ── Complete SPAKE2 ───────────────────────────────────────────────────────
    // peerMsg = Hello.pake_msg (side B's SPAKE2 message)
    const secret  = spake2FinishSender(spakeState, helloMsg.pake_msg, pwBytes);
    const keys    = deriveKeys(secret);
    const sendKey = keys.sendKey;
    recvKey       = keys.recvKey;
    const sendCtr = { v: 0n };

    // Flush pre-key rawQ messages into payBuf
    const flushed = rawQ.drain();
    keysReady = true;
    for (const bytes of flushed) {
      try {
        const msg = decodeMsg(bytes);
        if (msg.type === 'Encrypted') payBuf.feed(recvKey, msg);
      } catch { /* ignore */ }
    }

    onStatus('Waiting for receiver to be ready…');

    // ── Wait for Ready ────────────────────────────────────────────────────────
    // Ready is unencrypted; it may arrive in rawQ before keys were ready,
    // or we may need to read it from rawQ now (single-threaded, not yet flushed).
    // Actually Ready arrives AFTER we flush → it goes to payBuf erroneously.
    // No: Ready is NOT an Encrypted message, so our router ignores non-Encrypted msgs
    // when keysReady. We need to also handle unencrypted Ready in the router.
    // Fix: if keysReady and msg is NOT Encrypted, put it in rawQ still.

    // NOTE: The Ready message arrives after PakeReply is processed by the receiver.
    // At that point keysReady=true and the router only feeds Encrypted messages
    // to payBuf. The Ready (unencrypted) would be silently dropped.
    //
    // Solution: check keysReady=false window: Ready arrives AFTER we set keysReady.
    // But if we flush rawQ BEFORE receiving Ready, rawQ is empty and Ready goes to
    // the else branch where we try decodeMsg → type='Ready' which is not Encrypted
    // → we silently drop it. Bug!
    //
    // Fix: route non-Encrypted messages to rawQ regardless of keysReady.

    // The router is captured by closure; we can't change it now.
    // Instead: listen for Ready explicitly by reading rawQ, and also accept
    // it from payBuf (which won't have it, but that's fine).
    // We need to fix the router first:
    //   - Encrypted → payBuf
    //   - Everything else → rawQ (always)
    //
    // This is already handled below — we replaced the unsub with a correct one.

    // Re-sub with corrected router (non-Encrypted always go to rawQ)
    unsub();
    unsub = nymClient.events.subscribeToRawMessageReceivedEvent(e => {
      onPacketReceived?.();
      const bytes = e.args.payload;
      try {
        const msg = decodeMsg(bytes);
        if (msg.type === 'Encrypted') {
          payBuf.feed(recvKey, msg);
        } else {
          rawQ.push(bytes);
        }
      } catch {
        rawQ.push(bytes); // deliver unparseable to rawQ
      }
    });

    // Also flush any remaining rawQ items that might be Ready
    // (they were stashed there during the key exchange phase)
    let readyFound = false;
    const leftover = rawQ.drain();
    for (const bytes of leftover) {
      try {
        const msg = decodeMsg(bytes);
        if (msg.type === 'Ready') { readyFound = true; break; }
        if (msg.type === 'Encrypted') payBuf.feed(recvKey, msg);
      } catch { /* ignore */ }
    }

    if (!readyFound) {
      // Wait for Ready to arrive
      while (true) {
        const { ok } = await rawQ.next(30_000);
        const msg = decodeMsg(ok);
        if (msg.type === 'Ready') break;
        if (msg.type === 'Encrypted') payBuf.feed(recvKey, msg);
      }
    }

    // ── Send Offer ────────────────────────────────────────────────────────────
    onStatus('Sending file offer…');
    await rawSend(nymClient, receiverAddr,
      sealMsg(sendKey, ctrNext(sendCtr), {
        type:     'Offer',
        filename: file.name,
        filesize: BigInt(fileBytes.length),
        sha256:   fileHash,
      }), onPacketSent);

    // ── Wait for Accept or Reject ─────────────────────────────────────────────
    const decision = await payBuf.nextPayload(120_000);
    if (decision.type === 'Reject')
      throw new Error(`Receiver rejected the transfer: ${decision.reason}`);
    if (decision.type !== 'Accept')
      throw new Error(`Expected Accept/Reject, got ${decision.type}`);

    onStatus('Sending file…');

    // ── Chunk the file ────────────────────────────────────────────────────────
    const chunks = [];
    for (let off = 0; off < fileBytes.length; off += CHUNK_SIZE) {
      chunks.push(fileBytes.slice(off, off + CHUNK_SIZE));
    }
    const totalChunks = BigInt(chunks.length);
    let bytesSent = 0n;
    const fileSize = BigInt(fileBytes.length);

    // ── Send all chunks ───────────────────────────────────────────────────────
    for (let i = 0; i < chunks.length; i++) {
      const data = chunks[i];
      await rawSend(nymClient, receiverAddr,
        sealMsg(sendKey, ctrNext(sendCtr), { type: 'Chunk', seq: BigInt(i), data }), onPacketSent);
      bytesSent += BigInt(data.length);
      onProgress(bytesSent, fileSize);
    }

    // ── Send Done ─────────────────────────────────────────────────────────────
    await rawSend(nymClient, receiverAddr,
      sealMsg(sendKey, ctrNext(sendCtr), { type: 'Done', total_chunks: totalChunks }), onPacketSent);

    onStatus('File sent. Waiting for delivery confirmation…');

    // ── Wait for Ack (with retransmit handling) ───────────────────────────────
    const ACK_DEADLINE = Date.now() + 30 * 60 * 1000;

    while (true) {
      const remaining = ACK_DEADLINE - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for acknowledgement from receiver');

      let payload;
      try {
        payload = await payBuf.nextPayload(Math.min(remaining, 5_000));
      } catch {
        // Slice timeout — no action needed, loop continues
        continue;
      }

      if (payload.type === 'Ack') {
        if (!bytesEqual(payload.sha256, fileHash))
          throw new Error('Receiver reported a different file hash — possible corruption!');
        onStatus('Transfer confirmed by receiver!');
        onComplete();
        return;
      } else if (payload.type === 'Retransmit') {
        // Re-send the requested chunk and 31 following ones proactively
        const counter  = payload.counter;        // BigInt — the Msg::Encrypted counter
        const chunkIdx = Number(counter) - 1;    // Offer is counter 0, Chunk_0 is counter 1
        const end = Math.min(chunkIdx + 32, chunks.length);
        onStatus(`Retransmitting chunks ${chunkIdx}–${end - 1}…`);
        for (let i = chunkIdx; i < end; i++) {
          if (i < 0 || i >= chunks.length) continue;
          await rawSend(nymClient, receiverAddr,
            sealMsg(sendKey, ctrNext(sendCtr), { type: 'Chunk', seq: BigInt(i), data: chunks[i] }), onPacketSent);
        }
      } else if (payload.type === 'Error') {
        throw new Error(`Receiver error: ${payload.message}`);
      }
    }

  } finally {
    if (unsub) unsub();
  }
}
