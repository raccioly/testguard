// @req FR-03
// Issue #236, fast: a clean verdict is not carried forward over a program that changed elsewhere (stub typescript, test/helpers/typecheck-project.mjs).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { cleanupProjects, commitAll, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('reuse and the whole program', () => {
  it('a clean verdict is not carried forward over a program that changed elsewhere', async () => {
    // Type validity belongs to the whole program: no per-fault hash sees src/other.ts.
    const dir = stubProject();
    const first = await runProbe(dir, { only: ['OK'], typecheck: '' });
    expect(first.records[0]).toMatchObject({ verdict: 'killed', detail: { typecheck: 'clean' } });
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const unrelated = 1;\n');
    commitAll(dir, 'add an unrelated file');
    const again = await runProbe(dir, { only: ['OK'], typecheck: '', previous: first });
    expect(again.run.reuse).toEqual({ reused: 0, measured: 1 });
    expect(again.records[0]).toMatchObject({ verdict: 'fault-invalid', detail: { reason: 'replacement-does-not-typecheck', typecheck: 'diagnostics' } });
    // A refused fault is carried forward without any test run to confirm it.
    const refusedAgain = await runProbe(dir, { only: ['OK'], typecheck: '', previous: again });
    expect(refusedAgain.run.reuse).toEqual({ reused: 1, measured: 0 });
    expect(refusedAgain.run.measurements.reuseBaselineRuns).toBe(0);
  }, 180_000);

  it('a program that changed anywhere carries no verdict forward, even one the change did not touch (#293: the digest)', async () => {
    const dir = stubProject();
    const stable = await runProbe(dir, { only: ['AFTER'], typecheck: '' });
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const unrelated = 1;\n');
    commitAll(dir, 'add an unrelated file');
    const again = await runProbe(dir, { only: ['AFTER'], typecheck: '', previous: stable });
    expect(again.run.reuse).toEqual({ reused: 0, measured: 1 });
    expect(again.records[0]).toMatchObject({ verdict: 'killed', detail: { typecheck: 'clean' } });
  }, 120_000);
});
