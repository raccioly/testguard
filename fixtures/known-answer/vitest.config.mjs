import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Short so the `timeout` verdict is exercised quickly.
    testTimeout: 1000,
    include: ['test/**/*.test.mjs'],
  },
});
