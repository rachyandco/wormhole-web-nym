/**
 * WASM bridge for wormhole-nym-core.
 *
 * The published package is built with `wasm-pack --target bundler`: WASM is
 * initialised synchronously when this module is first imported. Vite resolves
 * the `.wasm` static import via `vite-plugin-wasm`.
 */

import {
  Spake2SenderState,
  Spake2ReceiverState,
  wasm_derive_keys,
  wasm_encrypt,
  wasm_decrypt,
  wasm_sha256,
} from '@rachyandco/wormhole-nym-wasm';

// ── SPAKE2 — same API as the original spake2.js ───────────────────────────────

/**
 * Start SPAKE2 as Side A (the wormhole-nym SENDER).
 * Returns { msg: Uint8Array, _state: Spake2SenderState }.
 * msg must be sent inside Msg::PakeReply.pake_msg.
 */
export function spake2StartSender(pw) {
  const r     = Spake2SenderState.start(pw);
  const msg   = r.pake_msg();
  const state = r.take_state();
  return { msg, _state: state };
}

/**
 * Finish SPAKE2 as Side A.
 * peerMsg: the 33-byte message received from Side B.
 * Returns the 32-byte shared secret (before key derivation).
 * The `pw` parameter is accepted for API compatibility but ignored
 * (the password was captured by the WASM state at start() time).
 */
export function spake2FinishSender(handle, peerMsg, _pw) {
  return handle._state.finish(peerMsg);
}

/**
 * Start SPAKE2 as Side B (the wormhole-nym RECEIVER).
 * Returns { msg: Uint8Array, _state: Spake2ReceiverState }.
 * msg must be sent inside Msg::Hello.pake_msg.
 */
export function spake2StartReceiver(pw) {
  const r     = Spake2ReceiverState.start(pw);
  const msg   = r.pake_msg();
  const state = r.take_state();
  return { msg, _state: state };
}

/**
 * Finish SPAKE2 as Side B.
 * peerMsg: the 33-byte message received from Side A.
 * Returns the 32-byte shared secret (before key derivation).
 */
export function spake2FinishReceiver(handle, peerMsg, _pw) {
  return handle._state.finish(peerMsg);
}

// ── Key derivation — same API as the original crypto.js ──────────────────────

/** Derive the two direction-specific 32-byte keys from the SPAKE2 shared secret. */
export function deriveKeys(sharedSecret) {
  const keys = wasm_derive_keys(sharedSecret);
  return { sendKey: keys.slice(0, 32), recvKey: keys.slice(32, 64) };
}

// ── Symmetric crypto — same API as the original crypto.js ────────────────────

/**
 * Encrypt `plaintext` with `key` (32 bytes) and monotonic `counter`.
 * Returns ciphertext with 16-byte Poly1305 authentication tag appended.
 */
export function encrypt(key, counter, plaintext) {
  return wasm_encrypt(key, counter, plaintext);
}

/**
 * Decrypt and authenticate `ciphertext` (includes 16-byte tag).
 * Throws if authentication fails.
 */
export function decrypt(key, counter, ciphertext) {
  return wasm_decrypt(key, counter, ciphertext);
}

/** SHA-256 of a single Uint8Array. */
export function sha256Hash(data) {
  return wasm_sha256(data);
}

/** Constant-time byte comparison. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
