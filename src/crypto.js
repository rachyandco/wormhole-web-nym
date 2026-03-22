/**
 * Symmetric crypto layer — matches wormhole-nym/src/crypto.rs.
 *
 * Key derivation:
 *   send_key = SHA-256(shared_secret || b"wormhole-nym-send")
 *   recv_key = SHA-256(shared_secret || b"wormhole-nym-recv")
 *
 * Encryption: ChaCha20-Poly1305 (IETF, 12-byte nonce)
 *   nonce = counter.to_le_bytes()[0..8] || 0x00000000
 */

import { sha256 } from '@noble/hashes/sha256';
import { chacha20poly1305 } from '@noble/ciphers/chacha';

const ENC_SUFFIX = new TextEncoder().encode('wormhole-nym-send');
const DEC_SUFFIX = new TextEncoder().encode('wormhole-nym-recv');

/** Derive the two direction-specific 32-byte keys from the SPAKE2 shared secret. */
export function deriveKeys(sharedSecret) {
  const sendKey = sha256concat(sharedSecret, ENC_SUFFIX);
  const recvKey = sha256concat(sharedSecret, DEC_SUFFIX);
  return { sendKey, recvKey };
}

function sha256concat(a, b) {
  const h = sha256.create();
  h.update(a);
  h.update(b);
  return h.digest();
}

/** Build the 12-byte nonce from a u64 counter (little-endian in first 8 bytes). */
function makeNonce(counter) {
  const nonce = new Uint8Array(12);
  let c = BigInt(counter);
  for (let i = 0; i < 8; i++) {
    nonce[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return nonce;
}

/**
 * Encrypt `plaintext` with `key` (32 bytes) and monotonic `counter`.
 * Returns ciphertext with 16-byte Poly1305 authentication tag appended.
 */
export function encrypt(key, counter, plaintext) {
  const nonce = makeNonce(counter);
  return chacha20poly1305(key, nonce).encrypt(plaintext);
}

/**
 * Decrypt and authenticate `ciphertext` (includes 16-byte tag).
 * Throws if authentication fails.
 */
export function decrypt(key, counter, ciphertext) {
  const nonce = makeNonce(counter);
  return chacha20poly1305(key, nonce).decrypt(ciphertext);
}

/** SHA-256 of a single Uint8Array. */
export function sha256Hash(data) {
  return sha256(data);
}

/** Constant-time-ish byte comparison. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
