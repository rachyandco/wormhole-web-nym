import { defineConfig } from 'vite';

export default defineConfig({
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
