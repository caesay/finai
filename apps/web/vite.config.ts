import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:3000';

const sharedSource = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve the shared package to its TypeScript source so edits there hot
    // reload instead of waiting for a rebuild of packages/shared/dist.
    alias: { '@finai/shared': sharedSource },
  },
  server: {
    port: 5173,
    // The API runs as a separate process in development; production serves
    // this bundle from the same origin, so the client always calls /api/*.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
