import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Each tot-mcp server picks its own ephemeral port at startup (reported in the
// get_status tool response). For `vite dev`, point the proxy at a running
// server by setting TOT_DEV_PORT to that port.
const devTarget = `http://localhost:${process.env.TOT_DEV_PORT ?? '8000'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/sse': devTarget,
      '/api': devTarget,
    },
  },
});
