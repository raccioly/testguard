import { availableParallelism } from 'node:os';
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Acceptance tests launch nested runners; reserve CPU for the developer.
    maxWorkers: process.env.CI ? 2 : Math.min(2, Math.max(1, availableParallelism() - 1)),
    // fixtures/ contains a deliberately flaky suite; it is driven by the
    // tool's own tests, never collected directly. Agent-managed worktrees are
    // separate checkouts too: collecting them makes this tree's result depend
    // on unrelated, potentially unfinished work.
    exclude: [...configDefaults.exclude, 'fixtures/**', '.claude/**'],
  },
});
