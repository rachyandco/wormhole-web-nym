import { defineConfig } from 'vite';

export default defineConfig({
  // On GitHub Pages the site lives at /wormhole-web-nym/.
  // Locally (npm run dev / npm run preview) it stays at /.
  base: process.env.VITE_BASE_URL ?? '/',

  optimizeDeps: {
    // These packages inline or fetch WASM; pre-bundling breaks them.
    exclude: ['@nymproject/sdk-full-fat', 'wormhole-nym-wasm'],
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
