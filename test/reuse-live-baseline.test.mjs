// Issue #232: no hash sees the environment, so one live unmodified run of the
// defender set licenses every carried-forward verdict.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, options, project } from './helpers/reuse-project.mjs';

describe('one live baseline before any reuse (#232)', () => {
  let dir;
  let first;
  // One measured probe shared by both cases, which run in order: the reuse
  // case leaves the tree unchanged, the red case changes it. This file is a
  // claim's defender, so every probe here is paid for on every fault.
  beforeAll(async () => {
    dir = project();
    first = await probe(options(dir));
    expect(first.records[0].verdict).toBe('killed');
  }, 30_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('runs one live baseline before reusing, and that run is measured', async () => {
    const second = await probe(options(dir, first));
    expect(second.records[0].reusedFrom).toBe(first.run.id);
    expect(second.run.measurements.runnerInvocations).toBe(1);
    expect(second.run.measurements.reuseBaselineRuns).toBe(1);
    expect(validate('evidence', second).errors).toEqual([]);
  }, 30_000);

  it('a defender red for a reason no hash covers is neither reused nor killed', async () => {
    // data/expected.json is read, never imported: outside every hash.
    writeFileSync(join(dir, 'data/expected.json'), JSON.stringify({ sum: 4 }));
    commit(dir);
    const second = await probe(options(dir, first));
    const record = second.records[0];
    expect(record.reusedFrom).toBeUndefined();
    expect(record.verdict).not.toBe('killed');
    expect(record.verdict).toBe('flaky-defender');
    // The one red reuse run is the first baseline run; the full probe finishes
    // the N runs so the failure rate is measured, as rule 1 requires.
    expect(record.detail.baselineRuns).toHaveLength(3);
    expect(record.detail.flakeRate).toEqual({ runs: 3, failures: 3 });
    expect(second.run.measurements.reuseBaselineRuns).toBe(1);
  }, 30_000);
});
