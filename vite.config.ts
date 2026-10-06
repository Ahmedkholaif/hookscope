import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, Vite serves the React app and proxies the API and capture
// endpoints to the Node server (npm run dev:server on :4000).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
      '/h': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
  test: { root: '.', include: ['web/src/**/*.test.ts'] },
});
