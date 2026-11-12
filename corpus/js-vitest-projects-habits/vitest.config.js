import { defineConfig } from 'vitest/config';

// Two projects (#277). test/shared.test.js belongs to BOTH, so it runs twice.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'streaks', include: ['test/streaks/**/*.test.js', 'test/shared.test.js'] } },
      { test: { name: 'weekly', include: ['test/weekly/**/*.test.js', 'test/shared.test.js'] } },
    ],
  },
});
