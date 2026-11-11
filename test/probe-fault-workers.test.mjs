// `probe --fault-workers` (issue #237) on a small native project: one tree per
// fault in flight, records in claim/fault order, and a verdict only contention
// produced is measured again alone. Kept to one fan-out run on purpose: this
// file defends self-probe claims and is run N times there. The serial answer
// for this project (FAST killed, MISSING unverifiable, QUIET survived, SLOW
// killed) was measured with --fault-workers 1; the full n = 1 versus n > 1
// record equality runs on the known-answer fixture in the native-performance
// CI job.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';

describe('a fan-out reports what a serial run reports', () => {
  let project;
  let evidence;
  const published = [];
  let peak = 0;

  beforeAll(async () => {
    project = fanOutProject();
    process.env.TG_FANOUT_MARKERS = project.markers;
    // Sample the worktree count while the probe runs: a fan-out that silently
    // fell back to one tree would pass every assertion about verdicts below.
    const sampler = setInterval(() => { peak = Math.max(peak, project.worktrees()); }, 50);
    try {
      evidence = await probe({
        projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3,
        budgetMs: 1200, escalate: false, faultWorkers: 3, onProgress: (record) => published.push(`${record.claim.id}/${record.subject.id}`),
      });
    } finally {
      clearInterval(sampler);
      delete process.env.TG_FANOUT_MARKERS;
    }
  }, 60_000);

  afterAll(() => {
    if (project) {
      rmSync(project.dir, { recursive: true, force: true });
      rmSync(project.markers, { recursive: true, force: true });
    }
  });

  it('ran one tree per fault in flight, and left none behind', () => {
    expect(peak).toBe(4); // the project and three scratch trees
    expect(project.worktrees()).toBe(1);
  });

  it('records and progress follow claim/fault order, with the serial verdicts', () => {
    const order = ['SLOW/F1', 'FAST/F1', 'MISSING/F1', 'QUIET/F1'];
    expect(evidence.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual(order);
    expect(published).toEqual(order);
    expect(Object.fromEntries(evidence.records.map((r) => [r.claim.id, r.verdict])))
      .toEqual({ FAST: 'killed', MISSING: 'unverifiable', QUIET: 'survived', SLOW: 'killed' });
  });

  it('a defender that times out only beside other suites is re-measured alone, and only that one', () => {
    const slow = evidence.records.find((r) => r.claim.id === 'SLOW');
    expect(slow.detail.remeasuredSerially).toBe(true);
    // The serial answer, measured in a fresh tree: not the contended timeout,
    // and not the survivor a re-measure in the contended tree would report.
    expect(slow.verdict).toBe('killed');
    expect(slow.detail.probeRuns).toHaveLength(3);
    expect(evidence.records.filter((r) => r.detail.remeasuredSerially).map((r) => r.claim.id)).toEqual(['SLOW']);
  });

  it('records the fan-out, charges overlapping runner time once, and conforms', () => {
    expect(evidence.run.faultWorkers).toBe(3);
    const m = evidence.run.measurements;
    expect(m.runnerMs).toBeLessThanOrEqual(m.elapsedMs);
    expect(m.overheadMs).toBeGreaterThanOrEqual(0);
    // Three baselines of three runs, measured once each before the fan-out;
    // FAST's and QUIET's three probe runs; QUIET's negative control; SLOW's one
    // contended run (a timeout stops the probe) and its three-run re-measure.
    expect(m.runnerInvocations).toBe(9 + 3 + 3 + 1 + 1 + 3);
    expect(validate('evidence', evidence).errors).toEqual([]);
  });
});
