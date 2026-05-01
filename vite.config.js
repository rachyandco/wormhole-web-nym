import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // On GitHub Pages the site lives at /wormhole-web-nym/.
  // Locally (npm run dev / npm run preview) it stays at /.
  base: process.env.VITE_BASE_URL ?? '/',

  plugins: [wasm()],

  optimizeDeps: {
    // sdk-full-fat inlines WASM as base64; pre-bundling breaks it.
    exclude: ['@nymproject/sdk-full-fat'],
  },
  build: {
    target: 'esnext',
    // Raise chunk size limit – the full-fat SDK is large (~5 MB)
    chunkSizeWarningLimit: 8192,
  },
  server: {
    fs: {
      // Allow Vite to serve files from the wormhole-nym workspace sibling
      // (needed for the wormhole-nym-wasm local package's .wasm file).
      allow: ['..'],
    },
    headers: {
      // Required for SharedArrayBuffer / WASM threads
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
