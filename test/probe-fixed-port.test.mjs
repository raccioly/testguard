// A suite that binds a fixed port (issue #270). One fault at a time it is
// ANSWER killed, GREETING survived. Two at a time, every overlapping run fails,
// so a fan-out that believed its contended runs would report GREETING killed:
// a kill that never happened. The guard must give the serial answer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fixedPortProject, freePort } from './helpers/fixed-port-project.mjs';

const SERIAL = { 'ANSWER/F1': 'killed', 'GREETING/F1': 'survived' };
const verdicts = (evidence) => Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]));

describe('a fan-out over a suite that shares a fixed port', () => {
  let project;
  let evidence;
  const warnings = [];

  beforeAll(async () => {
    project = fixedPortProject();
    process.env.TG_FIXED_PORT = String(await freePort());
    try {
      evidence = await probe({ projectDir: project.dir, claims: project.claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 20_000, escalate: false, faultWorkers: 2, onWarn: (m) => warnings.push(m) });
    } finally {
      delete process.env.TG_FIXED_PORT;
    }
  }, 120_000);

  afterAll(() => { if (project) rmSync(project.dir, { recursive: true, force: true }); });

  it('reports what a serial run reports, in order: no kill that did not happen', () => {
    expect(evidence.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual(Object.keys(SERIAL));
    expect(verdicts(evidence)).toEqual(SERIAL);
  });

  it('measured the survivor alone after its runs beside the other fault disagreed, and held the whole defender set to serial', () => {
    const [answer, greeting] = evidence.records;
    expect(greeting.detail.remeasuredSerially).toBe(true);
    expect(greeting.detail.notParallelSafe).toBe(true);
    expect(greeting.detail.probeRuns.every((r) => r.alone === true)).toBe(true);
    // The kill in the same set is not left resting on one run alone.
    expect(answer.detail.notParallelSafe).toBe(true);
    expect(answer.detail.remeasuredSerially).toBe(true);
    expect(answer.detail.probeRuns.every((r) => r.alone === true)).toBe(true);
    expect(warnings.some((w) => /not parallel-safe/.test(w) && /test\/service\.test\.mjs/.test(w))).toBe(true);
  });

  it('separates what the guard cost, and conforms', () => {
    const m = evidence.run.measurements;
    // How many kills reached the confirmation phase depends on which tree
    // finished first; at least one did, and both faults ended up measured alone.
    expect(m.aloneConfirmRuns).toBeGreaterThanOrEqual(1);
    expect(m.remeasuredFaults).toBe(2);
    expect(m.aloneConfirmMs).toBeGreaterThan(0);
    expect(m.remeasureMs).toBeGreaterThan(0);
    expect(validate('evidence', evidence).errors).toEqual([]);
  });
});
