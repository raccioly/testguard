// @req FR-03
// Issue #236, fast: a check over budget, and a tree that already fails (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { SRC, cleanupProjects, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('probe --typecheck preconditions', () => {
  it('a type check over its budget is a timeout, never a pass, and spends no test run', async () => {
    const evidence = await runProbe(stubProject(), { typecheck: '', only: ['SLOW'], budgetMs: 2_000 });
    expect(evidence.records[0]).toMatchObject({ verdict: 'timeout', detail: { reason: 'typecheck-timed-out', typecheck: 'timeout', baselineRuns: [], probeRuns: [] } });
  }, 60_000);

  it('a tree that already fails the check is a precondition error, before any fault', async () => {
    const dir = stubProject({ src: SRC.replace('return x + 1;', 'return x + 1; // BAD') });
    await expect(runProbe(dir, { typecheck: '' })).rejects.toThrow(PreconditionError);
    await expect(runProbe(dir, { typecheck: '' })).rejects.toThrow(/does not type-check[\s\S]*src\/a\.ts\(2,3\): error TS2322: bad replacement/);
  }, 60_000);
});
