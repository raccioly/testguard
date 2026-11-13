// A child that ignores SIGTERM is killed: the teardown sends SIGKILL (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { FIXTURES, cleanup, timed, bounded, allDead } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('A child that ignores SIGTERM is killed: the teardown send', () => {
  it('a child that ignores SIGTERM is killed (SIGKILL, not SIGTERM) and the teardown is confirmed', async () => {
    const run = await timed(FIXTURES.ignoresSigterm);
    bounded(run);
    expect(run.pids.length).toBeGreaterThan(0);
    expect(await allDead(run.pids)).toBe(true);
    expect(run.result.teardown).toBeUndefined();
    expect(run.result.loadMessage).toMatch(/every process of its tree was confirmed dead/);
  });
});
