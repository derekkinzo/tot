import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts', 'src/per-session.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
});
