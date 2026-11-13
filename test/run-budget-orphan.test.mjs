// A detached orphan holding the pipe: the run ends at the budget plus the grace and says it could not confirm (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { FIXTURES, cleanup, timed, bounded, GRACE } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('A detached orphan holding the pipe: the run ends at the b', () => {
  it('a detached grandchild nobody can find holds the pipe: the run still ends, and says it could not confirm', async () => {
    const run = await timed(FIXTURES.orphanHoldsPipe);
    bounded(run);
    expect(run.pids.length).toBeGreaterThan(0);
    expect(run.result.teardown).toMatchObject({ unconfirmed: true, pipeHeld: true });
    expect(run.result.loadMessage).toMatch(/teardown NOT confirmed.*output pipe was still held by a process TestGuard could not find/);
    expect(run.result.loadMessage).not.toMatch(/every process of its tree was confirmed dead/);
    // `durationMs` is the run, not the run plus its teardown: the pipe wait is teardown.
    expect(run.wallMs - run.result.run.durationMs).toBeGreaterThanOrEqual(GRACE - 100);
  });
});
