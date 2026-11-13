// A process that cannot be confirmed dead is counted and the run still ends at the grace (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { FIXTURES, cleanup, timed, bounded, pidsOf } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('A process that cannot be confirmed dead is counted and th', () => {
  it('a process that cannot be confirmed dead is reported with its count and the run still ends at the grace', async () => {
    // The table keeps listing one process of the run's group that no signal will ever remove.
    const ghost = 2_147_483_646;
    const processList = (dir) => () => {
      const pids = pidsOf(dir);
      return pids.length === 0 ? [] : [{ pid: ghost, ppid: pids[0], pgid: pids[0], stat: 'S' }];
    };
    const outcome = await timed(FIXTURES.ignoresSigterm, { processList });
    bounded(outcome);
    expect(outcome.result.teardown).toMatchObject({ unconfirmed: true, alive: 1 });
    expect(outcome.result.loadMessage).toMatch(/1 process of the run's tree still alive/);
  });
});
