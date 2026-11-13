// A teardown that could not be confirmed is reported, with its count, and the run still ends (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { FIXTURES, cleanup, timed, bounded, pidsOf } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('an unconfirmed teardown is said so, never success', () => {
  it('a process table that never reads is an unverified teardown', async () => {
    const run = await timed(FIXTURES.webServer, { processList: () => () => null });
    bounded(run);
    expect(run.result.teardown).toMatchObject({ unconfirmed: true, unlisted: true });
    expect(run.result.loadMessage).toMatch(/teardown NOT confirmed: .*process table could not be read/);
  });

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
