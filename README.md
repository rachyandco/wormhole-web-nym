# wormhole-web-nym

Browser-based file transfer over the [Nym mixnet](https://nym.com), fully compatible with the [wormhole-nym CLI](https://github.com/rachyandco/wormhole-nym).

No relay server. End-to-end encrypted. Sender anonymity via the mixnet.

## Live instance

A hosted instance is available at **https://nymtransfer.com**

No installation required — open the page and start transferring files.

## Run locally

```bash
npm install
npm run dev        # open http://localhost:5173
```

Production build (static site, deployable anywhere):
```bash
npm run build      # output in dist/
```

## Usage

### Receive a file from the CLI sender

```bash
# CLI side — sender generates a code and prints it:
wormhole-nym send myfile.zip
# Code: calm-fork-road:8yGFbT5ksqBMB…
```

1. Open the web app → **Receive a file** tab
2. Paste the code → **Connect**
3. Accept or reject the incoming offer
4. File downloads automatically to your browser's downloads folder

### Send a file to the CLI receiver

1. Open the web app → **Send a file** tab
2. Select your file → **Nym it (Start transfer)**
3. The app generates a wormhole code. Share it via:
   - **Copy code** / **Copy link** (paste into any chat)
   - **Share…** (mobile native share sheet, when available)
   - The QR code (in-person hand-off — receiver scans on another device)
4. CLI side runs: `wormhole-nym receive calm-fork-road:8yGFbT5ksq…`
5. Keep the page open and visible until the progress bar reaches 100% and the receiver confirms. On mobile, the app holds a screen Wake Lock while a transfer is active and re-checks the Nym connection on resume, but switching away from the browser may still interrupt the transfer.

### Web-to-web

Works the same way — one side sends, the other receives. Both use this web app.

## Architecture

```
src/
  wasm.js         Bridge to @rachyandco/wormhole-nym-wasm (SPAKE2, crypto, hashing)
  spake2.js       Re-exports SPAKE2 helpers from wasm.js
  crypto.js       Re-exports symmetric crypto helpers from wasm.js
  bincode.js      Bincode 1.x encoder/decoder (matches the Rust wire format)
  words.js        512-word list (identical to CLI) + password generator
  protocol.js     Msg + Payload encode/decode; seal/open helpers
  mixnet.js       Thin wrapper around the Nym SDK with restart/re-subscribe
  wormhole.js     Receiver and sender state machines
  main.js         UI logic (tabs, QR code, Web Share, Wake Lock)
  style.css       Dark + light theme CSS
```

### Shared protocol with the CLI

The crypto and protocol primitives (SPAKE2, ChaCha20-Poly1305, SHA-256, key derivation) are compiled from the same Rust source the CLI uses, via the [`@rachyandco/wormhole-nym-wasm`](https://www.npmjs.com/package/@rachyandco/wormhole-nym-wasm) npm package. That package is the `wasm/` crate of [wormhole-nym](https://github.com/rachyandco/wormhole-nym) built with `wasm-pack --target bundler`, so wire-format compatibility with the CLI is bit-perfect by construction.

| Layer          | CLI (Rust)              | Web (JS)                                            |
|----------------|-------------------------|-----------------------------------------------------|
| Mixnet         | `nym-sdk 1.20.4`        | `@nymproject/sdk-full-fat 1.4.1`                    |
| Transport      | `send_plain_message`    | `rawSend` / `subscribeToRawMessageReceivedEvent`    |
| Serialization  | `bincode 1`             | custom `bincode.js`                                 |
| SPAKE2         | `spake2 0.4 Ed25519`    | `@rachyandco/wormhole-nym-wasm` (same Rust crate)   |
| Encryption     | `chacha20poly1305 0.10` | `@rachyandco/wormhole-nym-wasm` (same Rust crate)   |
| Hashing        | `sha2 0.10`             | `@rachyandco/wormhole-nym-wasm` (same Rust crate)   |

The package is bundler-target, so Vite resolves the `.wasm` static import via `vite-plugin-wasm` (configured in `vite.config.js`).

### Nym SDK note

The Nym WebAssembly client (`sdk-full-fat`) inlines its own compiled WASM as base64, so no separate WASM file loading is needed for the mixnet client. The full bundle is ~6.6 MB JS + ~228 KB WASM; gzip reduces it to ~2.9 MB.

First connection to the Nym mixnet takes 20–40 seconds while the client registers with a gateway. The same `clientId` is reused across reloads (persisted in `localStorage`) so the Nym address is stable as long as the gateway re-accepts the registration.

## License

GPL-3.0 (same as wormhole-nym)
