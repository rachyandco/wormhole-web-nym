# wormhole-web-nym

Browser-based file transfer over the [Nym mixnet](https://nymtech.net), fully compatible with the [wormhole-nym CLI](https://github.com/rachyandco/wormhole-nym).

No relay server. End-to-end encrypted. Sender anonymity via the mixnet.

## Live instance

A hosted instance is available at **https://rachyandco.github.io/wormhole-web-nym/**

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
2. Select your file → **Start transfer**
3. The app generates a wormhole code — copy and share it
4. CLI side runs: `wormhole-nym receive calm-fork-road:8yGFbT5ksq…`
5. Keep the page open until the progress bar reaches 100% and the receiver confirms

### Web-to-web

Works the same way — one side sends, the other receives. Both use this web app.

## Architecture

```
src/
  bincode.js      Bincode 1.x encoder/decoder (compatible with Rust crate)
  words.js        512-word list (identical to CLI) + password generator
  spake2.js       SPAKE2 over Ed25519 (compatible with Rust spake2 v0.4.0)
  crypto.js       ChaCha20-Poly1305, key derivation, SHA-256
  protocol.js     Msg + Payload encode/decode; seal/open helpers
  wormhole.js     Receiver and sender state machines
  main.js         UI logic
  style.css       Dark theme CSS
```

### Protocol compatibility

The web app speaks exactly the same binary protocol as the CLI:

| Layer          | CLI (Rust)              | Web (JS)                         |
|----------------|-------------------------|----------------------------------|
| Mixnet         | `nym-sdk 1.20.4`        | `@nymproject/sdk-full-fat 1.4.1` |
| Transport      | `send_plain_message`    | `rawSend` / `subscribeToRawMessageReceivedEvent` |
| Serialization  | `bincode 1`             | custom `bincode.js`              |
| Key exchange   | `spake2 0.4 Ed25519`    | `@noble/curves` ed25519          |
| Encryption     | `chacha20poly1305 0.10` | `@noble/ciphers` chacha          |
| Hashing        | `sha2 0.10`             | `@noble/hashes` sha256           |

### Nym SDK note

The Nym WebAssembly client (`sdk-full-fat`) inlines the compiled WASM as base64, so no separate WASM file loading is needed. The bundle is ~7 MB; gzip reduces it to ~2.8 MB.

First connection to the Nym mixnet takes 20–40 seconds while the client registers with a gateway.

## Suggested changes to wormhole-nym CLI for shared protocol logic

To avoid duplicating protocol logic, the CLI could be restructured so that the core protocol (message types, SPAKE2 setup, crypto) is in a library crate that both the CLI binary and a future `wormhole-nym-wasm` WebAssembly target depend on:

```
wormhole-nym/
  lib/             # protocol, crypto, words — no tokio, no nym-sdk
    src/
      protocol.rs
      crypto.rs
      words.rs
  cli/             # nym-sdk transport + clap
    src/
      main.rs
      send.rs
      receive.rs
  wasm/            # wasm-bindgen bindings exposing seal/open/spake2
    src/
      lib.rs
```

The web app could then import `wormhole-nym-wasm` directly for the crypto/protocol layer instead of reimplementing it in JS, while keeping the Nym JS SDK for transport. This guarantees bit-perfect compatibility.

## License

GPL-3.0 (same as wormhole-nym)
