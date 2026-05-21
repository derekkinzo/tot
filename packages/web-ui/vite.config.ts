import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/sse': 'http://localhost:6274',
      '/api': 'http://localhost:6274',
    },
  },
});
