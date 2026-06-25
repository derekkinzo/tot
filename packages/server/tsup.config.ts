import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts', 'src/per-session.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  // The shared workspace package ships as raw TypeScript source with no build
  // of its own; bundle it into the server's single-file artifact rather than
  // leaving an unresolvable bare import in the published output.
  noExternal: [/@tot-mcp\/shared/],
});
