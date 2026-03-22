import { defineConfig } from 'vite';

export default defineConfig({
  // On GitHub Pages the site lives at /wormhole-web-nym/.
  // Locally (npm run dev / npm run preview) it stays at /.
  base: process.env.VITE_BASE_URL ?? '/',

  optimizeDeps: {
    // sdk-full-fat inlines WASM as base64; pre-bundling breaks it
    exclude: ['@nymproject/sdk-full-fat'],
  },
  build: {
    target: 'esnext',
    // Raise chunk size limit – the full-fat SDK is large (~5 MB)
    chunkSizeWarningLimit: 8192,
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer / WASM threads
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
