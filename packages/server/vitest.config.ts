import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    // Several suites create/remove real temp directories and bind ephemeral
    // HTTP servers in setup/teardown; under parallel load those fs/socket hooks
    // can exceed the 10s default and time out spuriously. Give them headroom.
    hookTimeout: 30_000,
  },
});
