import { defineConfig } from 'vitest/config';

// Three projects. `ui` and `node` both list tests/shared/; `legacy` lists a
// file whose path contains a ui test's path, which vitest's file filter
// matches unless the run names its project.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'ui', env: { WHICH: 'ui' }, include: ['tests/ui/**/*.test.mjs', 'tests/shared/**/*.test.mjs'] } },
      { test: { name: 'node', env: { WHICH: 'node' }, include: ['tests/shared/**/*.test.mjs'] } },
      { test: { name: 'legacy', include: ['legacy/**/*.test.mjs'] } },
    ],
  },
});
