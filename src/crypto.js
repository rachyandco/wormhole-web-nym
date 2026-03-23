/**
 * Symmetric crypto — backed by the wormhole-nym-core WASM crate for
 * bit-perfect compatibility with the CLI.  The API is unchanged from the
 * original JS implementation so protocol.js / wormhole.js require no changes.
 */
export {
  deriveKeys,
  encrypt,
  decrypt,
  sha256Hash,
  bytesEqual,
} from './wasm.js';
