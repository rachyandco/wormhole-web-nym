/**
 * Chat protocol — IRC-like rooms over the Nym mixnet.
 *
 * Wire format: all chat frames start with the 4-byte magic "CHAT" so the
 * existing file-transfer router silently ignores them (and vice-versa).
 *
 * After the magic, a u32 enum tag selects the frame:
 *
 *   0 Join        { nickname, return_addr, has_pake: u8, pake_msg }
 *   1 JoinAck     { has_pake: u8, pake_msg, room_name }
 *   2 JoinReject  { reason }
 *   3 Say         { nickname, text, ts_ms }                  // plain rooms
 *   4 Broadcast   { nickname, text, ts_ms }                  // plain rooms
 *   5 SystemMsg   { text }                                   // host→all
 *   6 Leave       { }
 *   7 Encrypted   { counter: u64, ciphertext }               // password rooms
 *
 * In an encrypted room the Say/Broadcast/SystemMsg/Leave frames are bincode-
 * encoded into the Encrypted body using SPAKE2-derived keys (one pair per
 * host↔participant link).  Direction keys mirror the file-transfer protocol:
 *   - participant (SPAKE2 sender role) encrypts outgoing with sendKey
 *   - host       (SPAKE2 receiver role) encrypts outgoing with recvKey
 *   - each side decrypts with the other key.
 *
 * Anonymous reply (SURBs) is intentionally NOT used here: the SDK only
 * supports attaching SURBs to a send and gives no reply primitive, so the
 * host needs each participant's Nym address to broadcast.  Participants
 * supply it in their Join frame.
 */

import { BincodeWriter, BincodeReader } from './bincode.js';
import { encrypt, decrypt, deriveKeys }  from './crypto.js';
import {
  spake2StartSender, spake2FinishSender,
  spake2StartReceiver, spake2FinishReceiver,
} from './spake2.js';

const MAGIC = new Uint8Array([0x43, 0x48, 0x41, 0x54]); // "CHAT"

// ── Frame encode / decode ─────────────────────────────────────────────────────

export function isChatFrame(bytes) {
  return bytes.length >= 4
    && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]
    && bytes[2] === MAGIC[2] && bytes[3] === MAGIC[3];
}

function encodeFrame(frame) {
  const w = new BincodeWriter();
  w.writeBytes(MAGIC);
  switch (frame.type) {
    case 'Join':
      w.writeU32(0);
      w.writeStr(frame.nickname);
      w.writeStr(frame.return_addr);
      w.writeU8(frame.pake_msg ? 1 : 0);
      w.writeVec(frame.pake_msg ?? new Uint8Array());
      break;
    case 'JoinAck':
      w.writeU32(1);
      w.writeU8(frame.pake_msg ? 1 : 0);
      w.writeVec(frame.pake_msg ?? new Uint8Array());
      w.writeStr(frame.room_name);
      break;
    case 'JoinReject':
      w.writeU32(2);
      w.writeStr(frame.reason);
      break;
    case 'Say':
      w.writeU32(3);
      w.writeStr(frame.nickname);
      w.writeStr(frame.text);
      w.writeU64(frame.ts_ms);
      break;
    case 'Broadcast':
      w.writeU32(4);
      w.writeStr(frame.nickname);
      w.writeStr(frame.text);
      w.writeU64(frame.ts_ms);
      break;
    case 'SystemMsg':
      w.writeU32(5);
      w.writeStr(frame.text);
      break;
    case 'Leave':
      w.writeU32(6);
      break;
    case 'Encrypted':
      w.writeU32(7);
      w.writeU64(frame.counter);
      w.writeVec(frame.ciphertext);
      break;
    default:
      throw new Error(`Unknown chat frame type: ${frame.type}`);
  }
  return w.toBytes();
}

export function decodeFrame(bytes) {
  const r = new BincodeReader(bytes);
  for (let i = 0; i < 4; i++) {
    if (r.readU8() !== MAGIC[i]) throw new Error('Not a chat frame');
  }
  const v = r.readU32();
  switch (v) {
    case 0: {
      const nickname    = r.readStr();
      const return_addr = r.readStr();
      const hasPake     = r.readU8();
      const pakeBytes   = r.readVec();
      return { type: 'Join', nickname, return_addr, pake_msg: hasPake ? pakeBytes : null };
    }
    case 1: {
      const hasPake   = r.readU8();
      const pakeBytes = r.readVec();
      const room_name = r.readStr();
      return { type: 'JoinAck', pake_msg: hasPake ? pakeBytes : null, room_name };
    }
    case 2: return { type: 'JoinReject', reason: r.readStr() };
    case 3: return { type: 'Say',        nickname: r.readStr(), text: r.readStr(), ts_ms: r.readU64() };
    case 4: return { type: 'Broadcast',  nickname: r.readStr(), text: r.readStr(), ts_ms: r.readU64() };
    case 5: return { type: 'SystemMsg',  text: r.readStr() };
    case 6: return { type: 'Leave' };
    case 7: return { type: 'Encrypted',  counter: r.readU64(), ciphertext: r.readVec() };
    default: throw new Error(`Unknown chat frame variant: ${v}`);
  }
}

// ── Encryption helpers ────────────────────────────────────────────────────────
// "Inner" frames (Say/Broadcast/SystemMsg/Leave) are bincode-encoded then
// wrapped in an Encrypted outer frame.

function encodeInner(frame) {
  const w = new BincodeWriter();
  switch (frame.type) {
    case 'Say':
      w.writeU32(3);
      w.writeStr(frame.nickname);
      w.writeStr(frame.text);
      w.writeU64(frame.ts_ms);
      break;
    case 'Broadcast':
      w.writeU32(4);
      w.writeStr(frame.nickname);
      w.writeStr(frame.text);
      w.writeU64(frame.ts_ms);
      break;
    case 'SystemMsg':
      w.writeU32(5);
      w.writeStr(frame.text);
      break;
    case 'Leave':
      w.writeU32(6);
      break;
    default:
      throw new Error(`Cannot seal frame type: ${frame.type}`);
  }
  return w.toBytes();
}

function decodeInner(bytes) {
  const r = new BincodeReader(bytes);
  const v = r.readU32();
  switch (v) {
    case 3: return { type: 'Say',        nickname: r.readStr(), text: r.readStr(), ts_ms: r.readU64() };
    case 4: return { type: 'Broadcast',  nickname: r.readStr(), text: r.readStr(), ts_ms: r.readU64() };
    case 5: return { type: 'SystemMsg',  text: r.readStr() };
    case 6: return { type: 'Leave' };
    default: throw new Error(`Unknown encrypted inner variant: ${v}`);
  }
}

function seal(key, counter, frame) {
  const ciphertext = encrypt(key, counter, encodeInner(frame));
  return encodeFrame({ type: 'Encrypted', counter, ciphertext });
}

function open(key, encFrame) {
  if (encFrame.type !== 'Encrypted') throw new Error('Not an Encrypted frame');
  return decodeInner(decrypt(key, encFrame.counter, encFrame.ciphertext));
}

function ctrNext(ref) {
  const old = ref.v;
  ref.v += 1n;
  return old;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start hosting a room.  Returns a controller {say, close, members, encrypted}.
 *
 * config: { roomName, nickname, password?, mixnet, callbacks }
 * callbacks: {
 *   onMessage({ nickname, text, ts_ms, kind: 'msg'|'system', encrypted })
 *   onMembersChanged(members: string[])
 *   onStatus?(text)
 * }
 */
export function hostRoom(config) {
  const { roomName, nickname, password, mixnet, callbacks } = config;
  const { onPacketSent, onPacketReceived } = callbacks;
  const encrypted = !!password;
  const pwBytes   = encrypted ? new TextEncoder().encode(password) : null;

  // Per-participant state.
  //   encKey = key the host encrypts outgoing with (= SPAKE2 recvKey)
  //   decKey = key the host decrypts incoming with (= SPAKE2 sendKey)
  //   encCtr = counter for our outgoing seals
  const participants = new Map();
  let closed = false;

  const membersList = () => [nickname, ...Array.from(participants.values()).map(p => p.nickname)];

  const sendTo = async (addr, p, frame) => {
    let bytes;
    if (encrypted && p.encKey) {
      bytes = seal(p.encKey, ctrNext(p.encCtr), frame);
    } else {
      bytes = encodeFrame(frame);
    }
    try {
      await mixnet.rawSend(addr, bytes);
      onPacketSent?.();
    } catch (e) { /* ignore single-recipient failures */ }
  };

  const broadcast = async (frame) => {
    for (const [addr, p] of participants) await sendTo(addr, p, frame);
  };

  const systemBroadcast = async (text) => {
    const frame = { type: 'SystemMsg', text };
    await broadcast(frame);
    callbacks.onMessage({ nickname: '', text, ts_ms: BigInt(Date.now()), kind: 'system', encrypted });
  };

  const onJoin = async (frame) => {
    let encKey = null, decKey = null;
    let ackPake = null;

    if (encrypted) {
      if (!frame.pake_msg) {
        try {
          await mixnet.rawSend(frame.return_addr,
            encodeFrame({ type: 'JoinReject', reason: 'Room is password-protected' }));
          onPacketSent?.();
        } catch {}
        return;
      }
      try {
        // Host acts as SPAKE2 Receiver (peer initiated with Join).
        const hostSpake = spake2StartReceiver(pwBytes);
        ackPake         = hostSpake.msg;
        const secret    = spake2FinishReceiver(hostSpake, frame.pake_msg, pwBytes);
        const keys      = deriveKeys(secret);
        // Host's outgoing = recvKey (it's the SPAKE2-Receiver role's outgoing key),
        // incoming = sendKey.
        encKey = keys.recvKey;
        decKey = keys.sendKey;
      } catch (e) {
        try {
          await mixnet.rawSend(frame.return_addr,
            encodeFrame({ type: 'JoinReject', reason: 'Key exchange failed (wrong password?)' }));
          onPacketSent?.();
        } catch {}
        return;
      }
    }

    const p = {
      nickname: frame.nickname,
      encKey, decKey,
      encCtr: { v: 0n },
      lastSeen: Date.now(),
    };
    participants.set(frame.return_addr, p);

    try {
      await mixnet.rawSend(frame.return_addr, encodeFrame({
        type: 'JoinAck',
        pake_msg: ackPake,
        room_name: roomName,
      }));
      onPacketSent?.();
    } catch {}

    callbacks.onMembersChanged(membersList());
    await systemBroadcast(`${frame.nickname} joined`);
  };

  const handleFrame = async (bytes) => {
    if (closed) return;
    let frame;
    try { frame = decodeFrame(bytes); } catch { return; }

    if (frame.type === 'Join') return onJoin(frame);

    if (!encrypted && frame.type === 'Say') {
      const out = { type: 'Broadcast', nickname: frame.nickname, text: frame.text, ts_ms: frame.ts_ms };
      await broadcast(out);
      callbacks.onMessage({ nickname: frame.nickname, text: frame.text, ts_ms: frame.ts_ms, kind: 'msg', encrypted });
      return;
    }

    if (encrypted && frame.type === 'Encrypted') {
      // Try each participant's decKey.
      for (const [addr, p] of participants) {
        if (!p.decKey) continue;
        let inner;
        try { inner = open(p.decKey, frame); } catch { continue; }
        p.lastSeen = Date.now();
        if (inner.type === 'Say') {
          const sender = inner.nickname || p.nickname;
          const out = { type: 'Broadcast', nickname: sender, text: inner.text, ts_ms: inner.ts_ms };
          await broadcast(out);
          callbacks.onMessage({ nickname: sender, text: inner.text, ts_ms: inner.ts_ms, kind: 'msg', encrypted });
        } else if (inner.type === 'Leave') {
          participants.delete(addr);
          callbacks.onMembersChanged(membersList());
          await systemBroadcast(`${p.nickname} left`);
        }
        return;
      }
    }
  };

  const unsub = mixnet.subscribe(e => {
    onPacketReceived?.();
    const bytes = e.args.payload;
    if (!isChatFrame(bytes)) return;
    handleFrame(bytes).catch(err => console.warn('Chat host handler error', err));
  });

  return {
    encrypted,
    members: membersList,
    async say(text) {
      const ts_ms = BigInt(Date.now());
      const frame = { type: 'Broadcast', nickname, text, ts_ms };
      await broadcast(frame);
      callbacks.onMessage({ nickname, text, ts_ms, kind: 'msg', encrypted });
    },
    close() {
      if (closed) return;
      closed = true;
      broadcast({ type: 'SystemMsg', text: 'Room closed by host' }).catch(() => {});
      unsub();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTICIPANT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join a room.  Resolves once JoinAck arrives (and SPAKE2 finishes if
 * password-protected).  Returns a controller {say, close, roomName, encrypted}.
 *
 * config: { hostAddress, nickname, password?, mixnet, callbacks }
 * callbacks: {
 *   onMessage({ nickname, text, ts_ms, kind, encrypted })
 *   onStatus?(text)
 *   onClosed?(reason)
 * }
 */
export async function joinRoom(config) {
  const { hostAddress, nickname, password, mixnet, callbacks } = config;
  const { onPacketSent, onPacketReceived } = callbacks;
  const encrypted = !!password;
  const pwBytes   = encrypted ? new TextEncoder().encode(password) : null;
  const encCtr    = { v: 0n };
  let encKey = null, decKey = null;
  let joined = false;
  let closed = false;

  const myAddr = mixnet.address;
  // Participant acts as SPAKE2 Sender (it initiates with Join).
  const spakeState = encrypted ? spake2StartSender(pwBytes) : null;

  let resolveJoin, rejectJoin;
  const joinPromise = new Promise((res, rej) => { resolveJoin = res; rejectJoin = rej; });

  const unsub = mixnet.subscribe(e => {
    if (closed) return;
    onPacketReceived?.();
    const bytes = e.args.payload;
    if (!isChatFrame(bytes)) return;
    let frame;
    try { frame = decodeFrame(bytes); } catch { return; }

    if (!joined) {
      if (frame.type === 'JoinAck') {
        if (encrypted) {
          if (!frame.pake_msg) { rejectJoin(new Error('Host did not return SPAKE2 message')); return; }
          try {
            const secret = spake2FinishSender(spakeState, frame.pake_msg, pwBytes);
            const keys   = deriveKeys(secret);
            // Participant outgoing = sendKey, incoming = recvKey.
            encKey = keys.sendKey;
            decKey = keys.recvKey;
          } catch (err) { rejectJoin(new Error('Key exchange failed: ' + err.message)); return; }
        }
        joined = true;
        resolveJoin({ roomName: frame.room_name });
        return;
      }
      if (frame.type === 'JoinReject') {
        rejectJoin(new Error(frame.reason || 'Join rejected by host'));
        return;
      }
      return;
    }

    // Post-join
    if (!encrypted) {
      if (frame.type === 'Broadcast') {
        callbacks.onMessage({ nickname: frame.nickname, text: frame.text, ts_ms: frame.ts_ms, kind: 'msg', encrypted });
        return;
      }
      if (frame.type === 'SystemMsg') {
        callbacks.onMessage({ nickname: '', text: frame.text, ts_ms: BigInt(Date.now()), kind: 'system', encrypted });
        if (frame.text === 'Room closed by host') {
          closed = true;
          callbacks.onClosed?.('Host closed the room');
        }
        return;
      }
      return;
    }

    if (encrypted && frame.type === 'Encrypted' && decKey) {
      let inner;
      try { inner = open(decKey, frame); } catch { return; }
      if (inner.type === 'Broadcast') {
        callbacks.onMessage({ nickname: inner.nickname, text: inner.text, ts_ms: inner.ts_ms, kind: 'msg', encrypted });
      } else if (inner.type === 'SystemMsg') {
        callbacks.onMessage({ nickname: '', text: inner.text, ts_ms: BigInt(Date.now()), kind: 'system', encrypted });
        if (inner.text === 'Room closed by host') {
          closed = true;
          callbacks.onClosed?.('Host closed the room');
        }
      }
    }
  });

  // Send Join with one retry on timeout
  const joinFrame = {
    type: 'Join',
    nickname,
    return_addr: myAddr,
    pake_msg: encrypted ? spakeState.msg : null,
  };
  const joinBytes = encodeFrame(joinFrame);
  await mixnet.rawSend(hostAddress, joinBytes);
  onPacketSent?.();
  callbacks.onStatus?.('Waiting for host to accept…');

  const waitFor = (ms) => Promise.race([
    joinPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('No response from host')), ms)),
  ]);

  let ackResult;
  try {
    ackResult = await waitFor(60_000);
  } catch (firstErr) {
    callbacks.onStatus?.('Retrying join…');
    try { await mixnet.rawSend(hostAddress, joinBytes); onPacketSent?.(); } catch {}
    try {
      ackResult = await waitFor(60_000);
    } catch (secondErr) {
      unsub();
      throw new Error('Host did not respond. The room may be closed.');
    }
  }

  return {
    encrypted,
    roomName: ackResult.roomName,
    async say(text) {
      if (closed) throw new Error('Room is closed');
      const ts_ms = BigInt(Date.now());
      let bytes;
      if (encrypted) {
        bytes = seal(encKey, ctrNext(encCtr), { type: 'Say', nickname, text, ts_ms });
      } else {
        bytes = encodeFrame({ type: 'Say', nickname, text, ts_ms });
      }
      await mixnet.rawSend(hostAddress, bytes);
      onPacketSent?.();
    },
    close() {
      if (closed) return;
      closed = true;
      const leaveBytes = encrypted && encKey
        ? seal(encKey, ctrNext(encCtr), { type: 'Leave' })
        : encodeFrame({ type: 'Leave' });
      mixnet.rawSend(hostAddress, leaveBytes).then(() => onPacketSent?.()).catch(() => {});
      unsub();
    },
  };
}
