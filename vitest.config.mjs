import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // fixtures/ contains a deliberately flaky suite; it is driven by the
    // tool's own tests, never collected directly.
    exclude: [...configDefaults.exclude, 'fixtures/**'],
  },
});
