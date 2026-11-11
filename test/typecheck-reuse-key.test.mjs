// @req FR-03
// Issue #236, fast: the type check is an input to reuse (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { cleanupProjects, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('reuse key', () => {
  it('a record measured without it is not reusable by a run with it; the same checker is', async () => {
    const dir = stubProject();
    const plain = await runProbe(dir, { only: ['OK'] });
    const typed = await runProbe(dir, { only: ['OK'], typecheck: '', previous: plain });
    expect(typed.run.reuse).toEqual({ reused: 0, measured: 1 });
    // and the same instrument is reused: the run's checker reaches the reuse decision
    expect((await runProbe(dir, { only: ['OK'], typecheck: '', previous: typed })).run.reuse).toEqual({ reused: 1, measured: 0 });
  }, 120_000);

});
