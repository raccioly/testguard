import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.mjs';

describe('the root test boundary', () => {
  it('never collects fixtures or agent-managed nested worktrees', () => {
    expect(config.test.maxWorkers).toBe(process.env.CI ? 2 : Math.min(2, Math.max(1, availableParallelism() - 1)));
    expect(config.test.exclude).toEqual(expect.arrayContaining([
      'fixtures/**',
      '.claude/**',
    ]));
  });
});
