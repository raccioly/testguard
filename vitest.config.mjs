import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // fixtures/ contains a deliberately flaky suite; it is driven by the
    // tool's own tests, never collected directly. Agent-managed worktrees are
    // separate checkouts too: collecting them makes this tree's result depend
    // on unrelated, potentially unfinished work.
    exclude: [...configDefaults.exclude, 'fixtures/**', '.claude/**'],
  },
});
