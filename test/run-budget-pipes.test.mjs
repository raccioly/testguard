// A survivor holding the output pipe never holds the run: it ends at the budget plus the grace (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { terminateAtBudget } from '../src/probe/runners/shared.mjs';
import { CommandBudget, BudgetExhaustedError } from '../src/command-budget.mjs';
import { GRACE, SLACK, FIXTURES, cleanup, timed, bounded, allDead, sleep, fresh } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('a run ends within its budget plus the grace', () => {
  it('a same-group grandchild holding the pipe after the child exits does not hold the run', async () => {
    const run = await timed(FIXTURES.groupGrandchildHoldsPipe);
    bounded(run);
    expect(await allDead(run.pids)).toBe(true);
  });

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

  it('a run capped by the command budget obeys the same bound, and the command budget still reads it as cut', async () => {
    const budget = new CommandBudget(700);
    const granted = budget.runBudget(120_000);
    expect(granted).toBeLessThanOrEqual(700);
    const run = await timed(FIXTURES.orphanHoldsPipe, { budgetMs: granted });
    bounded(run, granted);
    expect(() => budget.assertNotCut(granted, 120_000, run.result.timeouts)).toThrow(BudgetExhaustedError);
  });
});

describe('terminateAtBudget', () => {
  it('lets a caller that waits on `close` move on when a survivor holds the pipe', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.orphanHoldsPipe(dir)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise((done) => child.once('close', done));
    await sleep(200);
    const started = Date.now();
    terminateAtBudget(child, 200);
    await closed;
    expect(Date.now() - started).toBeLessThanOrEqual(200 + SLACK);
  });
});
