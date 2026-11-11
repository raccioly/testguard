// Baselines of independent defender sets are measured side by side under
// `--fault-workers` (#237 follow-up), and a baseline that is not green while
// another set was running is measured again alone before it is believed.
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fanOutProject } from './helpers/fan-out-project.mjs';

const strip = (value) => (Array.isArray(value) ? value.map(strip)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([k]) => !['durationMs', 'remeasuredSerially', 'baselineRemeasuredSerially'].includes(k)).map(([k, v]) => [k, strip(v)]))
    : value);

it('a baseline red only beside another set is re-measured alone, and the records are the serial ones', async () => {
  const project = fanOutProject({ only: ['BUSY', 'TOUCHY'], holdMs: 120 });
  process.env.TG_FANOUT_MARKERS = project.markers;
  try {
    const run = (faultWorkers) => probe({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 10_000, escalate: false, faultWorkers });
    const serial = await run(1);
    const fanned = await run(3);
    expect(fanned.records.map(strip)).toEqual(serial.records.map(strip));
    const byId = Object.fromEntries(fanned.records.map((r) => [r.claim.id, r]));
    expect(Object.fromEntries(fanned.records.map((r) => [r.claim.id, r.verdict]))).toEqual({ BUSY: 'killed', TOUCHY: 'killed' });
    // TOUCHY's baseline went red beside BUSY's and was measured again alone:
    // its record carries the serial, green runs and says so.
    expect(byId.TOUCHY.detail.baselineRemeasuredSerially).toBe(true);
    expect(byId.TOUCHY.detail.baselineRuns.map((r) => r.outcome)).toEqual(['pass', 'pass', 'pass']);
    // Only the set that came out red is re-measured.
    expect(fanned.records.filter((r) => r.detail.baselineRemeasuredSerially).map((r) => r.claim.id)).toEqual(['TOUCHY']);
    expect(serial.records.some((r) => r.detail.baselineRemeasuredSerially)).toBe(false);
    // The contended TOUCHY runs plus its serial re-measure, on top of the serial invocations.
    expect(fanned.run.measurements.runnerInvocations).toBeGreaterThan(serial.run.measurements.runnerInvocations);
    expect(validate('evidence', fanned).errors).toEqual([]);
    expect(project.worktrees()).toBe(1);
  } finally {
    delete process.env.TG_FANOUT_MARKERS;
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(project.markers, { recursive: true, force: true });
  }
}, 60_000);
