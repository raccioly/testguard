// The fast path through the command (issue #270): the default width comes
// from the machine and is recorded; a partial run reuses the last full probe;
// `--changed auto` with no base probes everything instead of nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { probeCommand } from '../src/commands/probe.mjs';
import { partialBudgetProject } from './helpers/partial-budget-project.mjs';
import { computeStatus } from '../src/status/status.mjs';

const base = { confirm: '3', budget: '20000', workers: '1', runner: 'node-test', severity: 'low', quiet: true, progress: 'none', 'no-escalate': true };
const run = async (project, values, deps = {}) => {
  const out = []; const err = [];
  const code = await probeCommand({ projectDir: project.dir, values: { ...base, ...values }, version: '0.0.0-test' }, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out, err };
};
const evidenceAt = (project, name) => JSON.parse(readFileSync(join(project.dir, '.testguard', name), 'utf8'));

describe('the CLI default width', () => {
  it('is automatic, from the CPUs, and the evidence says so', async () => {
    const saved = process.env.TESTGUARD_FAULT_WORKERS;
    delete process.env.TESTGUARD_FAULT_WORKERS;
    const project = partialBudgetProject();
    try {
      const r = await run(project, { claim: ['C1', 'C2'] }, { cpus: 4 });
      expect(r.code, r.err.join('\n')).toBe(0);
      const doc = evidenceAt(project, 'evidence-partial.json');
      expect(doc.run.faultWorkersSource).toBe('auto');
      expect(doc.run.cpus).toBe(4);
      // 4 CPUs → 2 at once, unless other runners were busy and it halved.
      expect([2, undefined]).toContain(doc.run.faultWorkers);
      expect(doc.records.map((rec) => rec.verdict)).toEqual(['killed', 'killed']);
    } finally {
      if (saved !== undefined) process.env.TESTGUARD_FAULT_WORKERS = saved;
      rmSync(project.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('--serial is one fault at a time, says so, and status says what that costs', async () => {
    const project = partialBudgetProject();
    try {
      const r = await run(project, { serial: true, quiet: false }, { cpus: 16 });
      expect(r.code).toBe(0);
      const doc = evidenceAt(project, 'evidence.json');
      expect(doc.run.faultWorkersSource).toBe('serial');
      expect(doc.run.faultWorkers).toBeUndefined();
      expect(doc.run.cpus).toBeUndefined();
      // The end of the run and the status document both name the faster command.
      expect(r.out.join('\n')).toMatch(/speed {5}The last probe ran with --serial on a machine with 16 CPUs.* → testguard probe/);
      const status = computeStatus({ projectDir: project.dir, toolVersion: '0.0.0-test', cpus: 16 });
      expect(status.advice).toEqual([expect.objectContaining({ id: 'serial-on-multicore', command: 'testguard probe' })]);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('a partial run reuses the last full probe', () => {
  it('--claim carries the canonical verdicts forward after one live baseline', async () => {
    const project = partialBudgetProject();
    try {
      const full = await run(project, {});
      expect(full.code, full.err.join('\n')).toBe(0);
      const canonical = evidenceAt(project, 'evidence.json');
      const partial = await run(project, { claim: ['C2', 'C3'] });
      expect(partial.code).toBe(0);
      const doc = evidenceAt(project, 'evidence-partial.json');
      expect(doc.records.map((rec) => rec.reusedFrom)).toEqual([canonical.run.id, canonical.run.id]);
      // One live run of each defender set licensed the carry-forward; no fault was applied.
      expect(doc.run.measurements.runnerInvocations).toBe(2);
      expect(doc.run.measurements.reuseBaselineRuns).toBe(2);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('--no-reuse reads neither file', async () => {
    const project = partialBudgetProject();
    try {
      await run(project, {});
      await run(project, { claim: ['C1'], 'no-reuse': true });
      expect(evidenceAt(project, 'evidence-partial.json').records[0].reusedFrom).toBeUndefined();
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('--changed auto', () => {
  it('with no base to compare against, probes every claim and says so: never a skip', async () => {
    const project = partialBudgetProject();
    try {
      const r = await run(project, { changed: 'auto' });
      expect(r.code).toBe(0);
      expect(r.err.join('\n')).toMatch(/--changed auto: no base to compare against .* so every claim is probed/);
      expect(evidenceAt(project, 'evidence.json').records).toHaveLength(4);
    } finally { rmSync(project.dir, { recursive: true, force: true }); }
  }, 60_000);
});
