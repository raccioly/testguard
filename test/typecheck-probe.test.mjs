// @req FR-03
// Issue #236, fast: probe --typecheck refuses a replacement the checker refuses, with no test run (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { byClaim, cleanupProjects, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('probe --typecheck refuses what the checker refuses', () => {
  it('a replacement the checker refuses is fault-invalid with no test run, and the next fault is not polluted by it', async () => {
    const evidence = await runProbe(stubProject(), { typecheck: '', only: ['OK', 'BAD', 'AFTER'] });
    const by = byClaim(evidence);
    expect(by.BAD).toMatchObject({ verdict: 'fault-invalid', detail: { reason: 'replacement-does-not-typecheck', typecheck: 'diagnostics', message: 'src/a.ts(2,3): error TS2322: bad replacement', baselineRuns: [], probeRuns: [] } });
    expect(by.OK).toMatchObject({ verdict: 'killed', detail: { typecheck: 'clean' } });
    expect(by.AFTER).toMatchObject({ verdict: 'killed', detail: { typecheck: 'clean' } });
    expect(by.AFTER.detail.message).toBeUndefined();
    expect(evidence.run.typecheck).toEqual({ commandHash: expect.stringMatching(/^[0-9a-f]{64}$/), version: '9.9.9' });
  }, 120_000);

});
