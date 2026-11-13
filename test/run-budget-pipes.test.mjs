// A same-group survivor holding the pipe, and a run capped by the command budget, obey the same bound (#310).
import { afterEach, describe, it, expect } from 'vitest';
import { CommandBudget, BudgetExhaustedError } from '../src/command-budget.mjs';
import { FIXTURES, cleanup, timed, bounded, allDead } from './helpers/process-tree.mjs';

afterEach(cleanup);

describe('a run ends within its budget plus the grace', () => {
  it('a same-group grandchild holding the pipe after the child exits does not hold the run', async () => {
    const run = await timed(FIXTURES.groupGrandchildHoldsPipe);
    bounded(run);
    expect(await allDead(run.pids)).toBe(true);
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
