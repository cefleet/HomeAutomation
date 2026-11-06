import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget =
  process.env.API_PROXY_TARGET ??
  (process.env.TLS_CERT ? 'https://localhost:3001' : 'http://localhost:3001');

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: apiProxyTarget, secure: false } },
  },
});
