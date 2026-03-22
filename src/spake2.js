/**
 * SPAKE2 over Ed25519 — compatible with the Rust `spake2` v0.4.0 crate.
 *
 * Protocol constants match spake2/src/ed25519.rs:
 *   M_BYTES  hex: 15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312
 *   N_BYTES  hex: f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3
 *
 * Key-derivation transcript (hash_ab in the Rust code):
 *   transcript = sha256(pw) || sha256(idA) || sha256(idB) || X_elem[32] || Y_elem[32] || K[32]
 *   shared_key = sha256(transcript)
 *
 * Password-to-scalar (ed25519_hash_to_scalar in the Rust code):
 *   HKDF(salt=b"", ikm=pw, hash=SHA-256, info="SPAKE2 pw", len=48)
 *   → interpret 48 bytes as big-endian integer, reduce mod Ed25519 order
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

// Party IDs (must match the Rust CLI)
const ID_A = new TextEncoder().encode('wormhole-nym-sender');
const ID_B = new TextEncoder().encode('wormhole-nym-receiver');

// Ed25519 group blinding points (from spake2 crate v0.4.0)
const M_BYTES = Uint8Array.from([
  0x15,0xcf,0xd1,0x8e,0x38,0x59,0x52,0x98,0x2b,0x6a,0x8f,0x8c,0x78,0x54,
  0x96,0x3b,0x58,0xe3,0x43,0x88,0xc8,0xe6,0xda,0xe8,0x91,0xdb,0x75,0x64,
  0x81,0xa0,0x23,0x12,
]);
const N_BYTES = Uint8Array.from([
  0xf0,0x4f,0x2e,0x7e,0xb7,0x34,0xb2,0xa8,0xf8,0xb4,0x72,0xea,0xf9,0xc3,
  0xc6,0x32,0x57,0x6a,0xc6,0x4a,0xea,0x65,0x0b,0x49,0x6a,0x8a,0x20,0xff,
  0x00,0xe5,0x83,0xc3,
]);

const M_POINT = ed25519.ExtendedPoint.fromHex(M_BYTES);
const N_POINT = ed25519.ExtendedPoint.fromHex(N_BYTES);
const G       = ed25519.ExtendedPoint.BASE;
const ORDER   = ed25519.CURVE.n; // 2^252 + 27742317777372353535851937790883648493n

// ── Helpers ──────────────────────────────────────────────────────────────────

/** HKDF-based password → Ed25519 scalar (matches ed25519_hash_to_scalar). */
function passwordToScalar(pw) {
  // HKDF(salt=b"", ikm=pw, hash=SHA-256, info="SPAKE2 pw", len=48)
  const okm = hkdf(sha256, pw, new Uint8Array(0), 'SPAKE2 pw', 48);
  // Interpret 48 bytes as a big-endian integer, reduce mod order
  let n = 0n;
  for (const b of okm) n = (n << 8n) | BigInt(b);
  return n % ORDER;
}

/** Cryptographically random scalar in [1, order-1]. */
function randomScalar() {
  // Sample 64 random bytes → uniform mod order
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return (n % (ORDER - 1n)) + 1n;
}

/** sha256(a || b || …) using streaming API. */
function sha256concat(...parts) {
  const h = sha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Transcript hash (hash_ab from Rust spake2 crate).
 * Both sides compute the same value regardless of who calls this.
 *   aElem: side A's 32-byte compressed point
 *   bElem: side B's 32-byte compressed point
 */
function hashAb(pw, aElem, bElem, kBytes) {
  const t = new Uint8Array(6 * 32);
  t.set(sha256concat(pw),  0);
  t.set(sha256concat(ID_A), 32);
  t.set(sha256concat(ID_B), 64);
  t.set(aElem,   96);   // A's element (no side byte)
  t.set(bElem,   128);  // B's element
  t.set(kBytes,  160);  // shared K
  return sha256concat(t);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start SPAKE2 as Side A (the wormhole-nym SENDER).
 * Returns { msg: Uint8Array(33), _state: opaque }.
 * msg must be sent inside Msg::PakeReply.pake_msg.
 */
export function spake2StartSender(pw) {
  const pwScalar = passwordToScalar(pw);
  const x = randomScalar();
  // X = G*x + M*pw
  const X = G.multiply(x).add(M_POINT.multiply(pwScalar));
  const xBytes = X.toRawBytes(); // 32 bytes compressed Edwards
  const msg = new Uint8Array(33);
  msg[0] = 0x41; // 'A'
  msg.set(xBytes, 1);
  return { msg, _x: x, _pwScalar: pwScalar, _xBytes: xBytes };
}

/**
 * Finish SPAKE2 as Side A.
 * peerMsg: the 33-byte message received from Side B (starts with 0x42).
 * Returns the 32-byte shared secret (before key derivation).
 */
export function spake2FinishSender(state, peerMsg, pw) {
  if (peerMsg[0] !== 0x42)
    throw new Error(`SPAKE2: expected B-side message (0x42), got 0x${peerMsg[0].toString(16)}`);
  const { _x: x, _pwScalar: pwScalar, _xBytes: xBytes } = state;
  const yBytes = peerMsg.slice(1);
  const Y = ed25519.ExtendedPoint.fromHex(yBytes);
  // K = (Y + N*(-pw)) * x
  const negPw = (ORDER - pwScalar) % ORDER;
  const K = Y.add(N_POINT.multiply(negPw)).multiply(x);
  return hashAb(pw, xBytes, yBytes, K.toRawBytes());
}

/**
 * Start SPAKE2 as Side B (the wormhole-nym RECEIVER).
 * Returns { msg: Uint8Array(33), _state: opaque }.
 * msg must be sent inside Msg::Hello.pake_msg.
 */
export function spake2StartReceiver(pw) {
  const pwScalar = passwordToScalar(pw);
  const y = randomScalar();
  // Y = G*y + N*pw
  const Y = G.multiply(y).add(N_POINT.multiply(pwScalar));
  const yBytes = Y.toRawBytes();
  const msg = new Uint8Array(33);
  msg[0] = 0x42; // 'B'
  msg.set(yBytes, 1);
  return { msg, _y: y, _pwScalar: pwScalar, _yBytes: yBytes };
}

/**
 * Finish SPAKE2 as Side B.
 * peerMsg: the 33-byte message received from Side A (starts with 0x41).
 * Returns the 32-byte shared secret (before key derivation).
 */
export function spake2FinishReceiver(state, peerMsg, pw) {
  if (peerMsg[0] !== 0x41)
    throw new Error(`SPAKE2: expected A-side message (0x41), got 0x${peerMsg[0].toString(16)}`);
  const { _y: y, _pwScalar: pwScalar, _yBytes: yBytes } = state;
  const xBytes = peerMsg.slice(1);
  const X = ed25519.ExtendedPoint.fromHex(xBytes);
  // K = (X + M*(-pw)) * y
  const negPw = (ORDER - pwScalar) % ORDER;
  const K = X.add(M_POINT.multiply(negPw)).multiply(y);
  // Transcript: A's element first, then B's
  return hashAb(pw, xBytes, yBytes, K.toRawBytes());
}
