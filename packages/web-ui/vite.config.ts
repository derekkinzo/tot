import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Each tot-mcp server picks its own ephemeral port at startup (reported in the
// get_status tool response). `vite dev` therefore cannot assume a fixed port:
// set TOT_DEV_PORT to the running server's port. It is required for dev (there
// is no sensible default — a hardcoded port would silently proxy to a dead
// target); the production build needs no proxy and ignores it.
export default defineConfig(({ command }) => {
  const config: Parameters<typeof defineConfig>[0] = { plugins: [react()] };
  if (command === 'serve') {
    const port = process.env.TOT_DEV_PORT;
    if (!port) {
      throw new Error(
        'TOT_DEV_PORT is required for `vite dev`: set it to the port a running tot-mcp ' +
        "server reports in its get_status 'Visualization: http://localhost:<port>' line.",
      );
    }
    const target = `http://localhost:${port}`;
    config.server = { proxy: { '/sse': target, '/api': target } };
  }
  return config;
});
