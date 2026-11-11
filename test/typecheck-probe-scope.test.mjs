// @req FR-03
// Issue #236, fast: what the type check judges, and what it leaves alone (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { cleanupProjects, runProbe, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('probe --typecheck scope', () => {
  it('the same fault without --typecheck is probed like any other: it survives, and the evidence says nothing about a type check', async () => {
    const evidence = await runProbe(stubProject(), { only: ['BAD'] });
    expect(evidence.records[0].verdict).toBe('survived');
    expect(evidence.run.typecheck).toBeUndefined();
    expect(evidence.records[0].detail.typecheck).toBeUndefined();
  }, 120_000);

  it('a file the checker does not judge is recorded not-applicable and probed as before', async () => {
    const evidence = await runProbe(stubProject(), { typecheck: '', only: ['JS'] });
    expect(evidence.records[0]).toMatchObject({ verdict: 'killed', detail: { typecheck: 'not-applicable' } });
  }, 120_000);

});
