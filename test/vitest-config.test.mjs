import { describe, expect, it } from 'vitest';
import config from '../vitest.config.mjs';

describe('the root test boundary', () => {
  it('never collects fixtures or agent-managed nested worktrees', () => {
    expect(config.test.exclude).toEqual(expect.arrayContaining([
      'fixtures/**',
      '.claude/**',
    ]));
  });
});
