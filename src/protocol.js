/**
 * Bincode encode/decode for the wormhole-nym wire protocol.
 * Matches protocol.rs exactly (same variant order, same field order).
 *
 * Msg variants:
 *   0 Hello      { receiver_address: String, pake_msg: Vec<u8> }
 *   1 PakeReply  { pake_msg: Vec<u8> }
 *   2 Ready
 *   3 Encrypted  { counter: u64, ciphertext: Vec<u8> }
 *
 * Payload variants (sent inside Encrypted.ciphertext):
 *   0 Offer      { filename: String, filesize: u64, sha256: [u8;32] }
 *   1 Accept
 *   2 Reject     { reason: String }
 *   3 Chunk      { seq: u64, data: Vec<u8> }
 *   4 Done       { total_chunks: u64 }
 *   5 Ack        { sha256: [u8;32] }
 *   6 Error      { message: String }
 *   7 Retransmit { counter: u64 }
 */

import { BincodeWriter, BincodeReader } from './bincode.js';
import { encrypt, decrypt } from './crypto.js';

// ── Msg ───────────────────────────────────────────────────────────────────────

export function encodeMsg(msg) {
  const w = new BincodeWriter();
  switch (msg.type) {
    case 'Hello':
      w.writeU32(0);
      w.writeStr(msg.receiver_address);
      w.writeVec(msg.pake_msg);
      break;
    case 'PakeReply':
      w.writeU32(1);
      w.writeVec(msg.pake_msg);
      break;
    case 'Ready':
      w.writeU32(2);
      break;
    case 'Encrypted':
      w.writeU32(3);
      w.writeU64(msg.counter);
      w.writeVec(msg.ciphertext);
      break;
    default:
      throw new Error(`Unknown Msg type: ${msg.type}`);
  }
  return w.toBytes();
}

export function decodeMsg(bytes) {
  const r = new BincodeReader(bytes);
  const v = r.readU32();
  switch (v) {
    case 0: return { type: 'Hello',     receiver_address: r.readStr(), pake_msg: r.readVec() };
    case 1: return { type: 'PakeReply', pake_msg: r.readVec() };
    case 2: return { type: 'Ready' };
    case 3: return { type: 'Encrypted', counter: r.readU64(), ciphertext: r.readVec() };
    default: throw new Error(`Unknown Msg variant: ${v}`);
  }
}

// ── Payload ───────────────────────────────────────────────────────────────────

export function encodePayload(p) {
  const w = new BincodeWriter();
  switch (p.type) {
    case 'Offer':
      w.writeU32(0);
      w.writeStr(p.filename);
      w.writeU64(p.filesize);
      w.writeFixed(p.sha256);    // [u8; 32]
      break;
    case 'Accept':
      w.writeU32(1);
      break;
    case 'Reject':
      w.writeU32(2);
      w.writeStr(p.reason);
      break;
    case 'Chunk':
      w.writeU32(3);
      w.writeU64(p.seq);
      w.writeVec(p.data);
      break;
    case 'Done':
      w.writeU32(4);
      w.writeU64(p.total_chunks);
      break;
    case 'Ack':
      w.writeU32(5);
      w.writeFixed(p.sha256);    // [u8; 32]
      break;
    case 'Error':
      w.writeU32(6);
      w.writeStr(p.message);
      break;
    case 'Retransmit':
      w.writeU32(7);
      w.writeU64(p.counter);
      break;
    default:
      throw new Error(`Unknown Payload type: ${p.type}`);
  }
  return w.toBytes();
}

export function decodePayload(bytes) {
  const r = new BincodeReader(bytes);
  const v = r.readU32();
  switch (v) {
    case 0: return { type: 'Offer',      filename: r.readStr(), filesize: r.readU64(), sha256: r.readFixed(32) };
    case 1: return { type: 'Accept' };
    case 2: return { type: 'Reject',     reason: r.readStr() };
    case 3: return { type: 'Chunk',      seq: r.readU64(), data: r.readVec() };
    case 4: return { type: 'Done',       total_chunks: r.readU64() };
    case 5: return { type: 'Ack',        sha256: r.readFixed(32) };
    case 6: return { type: 'Error',      message: r.readStr() };
    case 7: return { type: 'Retransmit', counter: r.readU64() };
    default: throw new Error(`Unknown Payload variant: ${v}`);
  }
}

// ── Helpers: seal/open ────────────────────────────────────────────────────────

/** Encode payload → encrypt → wrap in Encrypted Msg → encode Msg → bytes. */
export function sealMsg(key, counter, payload) {
  const plaintext  = encodePayload(payload);
  const ciphertext = encrypt(key, counter, plaintext);
  return encodeMsg({ type: 'Encrypted', counter, ciphertext });
}

/** Decode Encrypted Msg → decrypt → decode payload. */
export function openMsg(key, encryptedMsg) {
  if (encryptedMsg.type !== 'Encrypted')
    throw new Error(`Expected Encrypted, got ${encryptedMsg.type}`);
  const plaintext = decrypt(key, encryptedMsg.counter, encryptedMsg.ciphertext);
  return decodePayload(plaintext);
}
