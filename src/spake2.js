/**
 * SPAKE2 — backed by the wormhole-nym-core WASM crate for bit-perfect
 * compatibility with the CLI.  The API is unchanged from the original
 * JS reimplementation so wormhole.js requires no import changes.
 */
export {
  spake2StartSender,
  spake2FinishSender,
  spake2StartReceiver,
  spake2FinishReceiver,
} from './wasm.js';
