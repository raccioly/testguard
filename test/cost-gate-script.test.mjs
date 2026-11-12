// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './helpers/yaml.mjs';
import { median } from '../src/probe/cost.mjs';
import { measureReference, WORKLOAD } from '../.github/scripts/measure-reference.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'tg-cost-gate-'));
const write = (name, value) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
/** Claims of at most half the per-claim ceiling each, so the raw total is exactly `seconds` and only the total can trip. */
const evidence = (seconds) => {
  const each = budget.perClaimSeconds / 2;
  const records = Array.from({ length: Math.ceil(seconds / each) }, (_, i) => ({
    claim: { id: `C${i}` }, subject: { id: 'F1' }, defenders: { resolved: ['a.test.mjs'] },
    detail: { baselineRuns: [], probeRuns: [{ durationMs: Math.min(each, seconds - i * each) * 1000 }] },
  }));
  // The run's elapsed time is what the ceiling gates (#284); here it equals the sum.
  return write(`evidence-${seconds}.json`, { run: { measurements: { elapsedMs: seconds * 1000 }, ...(budget.faultWorkers > 1 ? { faultWorkers: budget.faultWorkers } : {}) }, records });
};
// A measurement from the runner class the baseline was taken on, unless the caller says it ran elsewhere.
const measurement = (medianMs, workload = budget.reference.workload, runner = { cpus: budget.reference.cpus, platform: budget.reference.platform }) => write(`ref-${medianMs}-${workload}-${runner.cpus}-${runner.platform}.json`, { workload, medianMs, ...runner });
const gate = (evidencePath, ...flags) => spawnSync(process.execPath, [join(ROOT, '.github/scripts/check-cost-budget.mjs'), evidencePath, ...flags], { encoding: 'utf8', cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
const atBaseline = budget.reference.baselineMs;
// Well under both ceilings, so only the reference can decide the outcome.
const SMALL = Math.min(budget.perClaimSeconds, budget.seconds) / 2;

describe('check-cost-budget.mjs fails closed on its reference', () => {
  it('passes a small run measured at the baseline speed, printing raw seconds, both medians, the factor and the normalized seconds', () => {
    const r = gate(evidence(SMALL), '--reference-before', measurement(atBaseline), '--reference-after', measurement(atBaseline));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/raw \d+s; reference before .* after .* baseline .* speed factor 1\.00; normalized \d+s/);
    expect(r.stdout).toMatch(/^cost-measurement \{.*"basis":"normalized-elapsed".*"ok":true/m);
  });

  it('fails when no reference file is given at all, naming the reference, not the budget', () => {
    const r = gate(evidence(1));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COST REFERENCE MISSING');
    expect(r.stdout).toMatch(/"failures":\["reference-missing"\]/);
  });

  it('fails when a reference file does not exist or is not JSON', () => {
    const junk = join(dir, 'junk.json');
    writeFileSync(junk, 'not json');
    for (const [before, after] of [[join(dir, 'absent.json'), measurement(atBaseline)], [measurement(atBaseline), junk]]) {
      const r = gate(evidence(1), '--reference-before', before, '--reference-after', after);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('COST REFERENCE MISSING');
    }
  });

  it('refuses a measurement of a different workload than the baseline was taken with', () => {
    const r = gate(evidence(1), '--reference-before', measurement(atBaseline, 'something-else'), '--reference-after', measurement(atBaseline));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COST REFERENCE MISSING');
  });

  it('fails closed when the measurement came from another CPU count or platform than the baseline, naming both, and when it does not say', () => {
    const laptop = { cpus: budget.reference.cpus + 14, platform: 'darwin' };
    const wrong = gate(evidence(1), '--reference-before', measurement(atBaseline, undefined, laptop), '--reference-after', measurement(atBaseline, undefined, laptop));
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('COST REFERENCE RUNNER MISMATCH');
    expect(wrong.stdout).toContain(`${budget.reference.cpus} CPUs (${budget.reference.platform})`);
    expect(wrong.stdout).toContain(`${laptop.cpus} CPUs (darwin)`);
    expect(wrong.stdout).toMatch(/"failures":\["reference-runner-mismatch"\]/);
    const unsaid = gate(evidence(1), '--reference-before', write('ref-unsaid.json', { workload: budget.reference.workload, medianMs: atBaseline }), '--reference-after', measurement(atBaseline));
    expect(unsaid.status).toBe(1);
    expect(unsaid.stdout).toContain('COST REFERENCE RUNNER MISMATCH');
  });

  it('a drifted run is read at the faster reading through the script too', () => {
    const raw = budget.seconds * 0.9;
    const stable = gate(evidence(raw), '--reference-before', measurement(atBaseline * 1.2), '--reference-after', measurement(atBaseline * 1.2));
    const drifted = gate(evidence(raw), '--reference-before', measurement(atBaseline * 0.85), '--reference-after', measurement(atBaseline * 1.6));
    expect(stable.status).toBe(0);
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toMatch(/pessimistic reading/);
    expect(drifted.stdout).toMatch(/"factorBasis":"pessimistic"/);
  });

  it('fails an absurd factor even though the raw seconds are tiny', () => {
    const r = gate(evidence(1), '--reference-before', measurement(atBaseline * 4), '--reference-after', measurement(atBaseline * 4));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COST REFERENCE OUT OF RANGE');
  });

  it('a fast runner hides nothing: the same raw seconds that pass at baseline speed fail when the reference says the runner is fast', () => {
    const raw = budget.seconds * 0.9;
    const atSpeed = gate(evidence(raw), '--reference-before', measurement(atBaseline), '--reference-after', measurement(atBaseline));
    const fast = gate(evidence(raw), '--reference-before', measurement(atBaseline * 0.6), '--reference-after', measurement(atBaseline * 0.6));
    expect(atSpeed.status).toBe(0);
    expect(fast.status).toBe(1);
    expect(fast.stdout).toContain('COST BUDGET EXCEEDED');
  });
});

describe('check-cost-budget.mjs --report-only (a scoped pull-request run)', () => {
  const over = () => evidence(budget.seconds * 2);
  const ref = () => ['--reference-before', measurement(atBaseline), '--reference-after', measurement(atBaseline)];

  it('reports a run over the ceiling as a warning and exits 0, where the full gate exits 1', () => {
    const gated = gate(over(), ...ref());
    expect(gated.status).toBe(1);
    const reported = gate(over(), ...ref(), '--report-only');
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain('COST BUDGET EXCEEDED');
    expect(reported.stdout).toMatch(/::warning::scoped run, reported not gated/);
    expect(reported.stdout).toMatch(/^cost-measurement \{.*"ok":false/m);
  });

  it('does not excuse a missing reference: that is still reported, and still a warning only', () => {
    const r = gate(evidence(1), '--report-only');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COST REFERENCE MISSING');
  });

  it('a change that selected no claim leaves no evidence: reported, not an error; a full gate still fails on it', () => {
    const absent = join(dir, 'never-written.json');
    const reported = gate(absent, '--report-only');
    expect(reported.status).toBe(0);
    expect(reported.stdout).toMatch(/selected no claim/);
    expect(gate(absent).status).not.toBe(0);
  });
});

describe('the budget file records how its reference was taken', () => {
  it('names the workload the script measures and a positive baseline, range and drift limit', () => {
    expect(budget.reference.workload).toBe(WORKLOAD);
    expect(budget.reference.baselineMs).toBeGreaterThan(0);
    expect(Number.isInteger(budget.reference.cpus) && budget.reference.cpus > 0).toBe(true);
    expect(budget.reference.platform).toMatch(/^[a-z0-9]+$/);
    expect(budget.reference.factorRange[0]).toBeLessThan(1);
    expect(budget.reference.factorRange[1]).toBeGreaterThan(1);
    expect(budget.reference.maxDrift).toBeGreaterThan(1);
  });
});

describe('measure-reference.mjs', () => {
  it('starts the fixed project the asked number of times and reports the median of exactly those samples', () => {
    const r = measureReference({ runs: 3 });
    expect(r).toMatchObject({ workload: WORKLOAD, runs: 3, platform: process.platform });
    expect(Number.isInteger(r.cpus) && r.cpus > 0).toBe(true);
    expect(r.samplesMs).toHaveLength(3);
    expect(r.samplesMs.every((x) => x > 0)).toBe(true);
    expect(r.medianMs).toBe(median(r.samplesMs));
  }, 60_000);

  it('refuses a batch with no median to take', () => {
    for (const runs of [0, 1, 2, 4, 2.5, '3']) expect(() => measureReference({ runs })).toThrow(RangeError);
  });
});

describe('ci.yml times the reference around every self-probe, in the same job', () => {
  const workflow = parseYaml(join(ROOT, '.github', 'workflows', 'ci.yml'))[0];
  const names = (job) => workflow.jobs[job].steps.map((st) => st.name ?? '');
  const step = (job, name) => workflow.jobs[job].steps.find((st) => st.name === name);

  it('measures before the probe and after it, on the runner that probed, in each probing job', () => {
    for (const [job, probe] of [['selfprobe', "probe this shard's claims"], ['selfprobe-scoped', "probe TestGuard's own claims — only what this pull request can affect"]]) {
      const n = names(job);
      const before = n.indexOf('Time the reference workload before the probe');
      const after = n.indexOf('Time the reference workload after the probe');
      expect(before, job).toBeGreaterThan(-1);
      expect(before, job).toBeLessThan(n.indexOf(probe));
      expect(n.indexOf(probe), job).toBeLessThan(after);
      expect(step(job, 'Time the reference workload before the probe').run).toContain('measure-reference.mjs --out .testguard/reference-before.json');
      expect(step(job, 'Time the reference workload after the probe').run).toContain('measure-reference.mjs --out .testguard/reference-after.json');
    }
  });

  it('measures after the probe even when the probe failed', () => {
    expect(step('selfprobe', 'Time the reference workload after the probe').if).toBe('always()');
    expect(step('selfprobe-scoped', 'Time the reference workload after the probe').if).toBe('always()');
  });

  it('ships each shard\'s evidence together with its own two reference timings, and the cost gate reads them per shard', () => {
    expect(step('selfprobe', 'Collect this shard\'s evidence and its reference timings').run).toMatch(/reference-before\.json .testguard\/reference-after\.json .testguard\/shard-out/);
    const gate = step('selfprobe-gate', 'The gate must stay inside its cost budget');
    expect(gate.run).toBe('node .github/scripts/check-shard-cost.mjs shards');
    expect(gate.if).toContain('always()');
    expect(step('selfprobe-scoped', 'Cost of the scoped run (reported, not gated)').run).toMatch(/--reference-before \.testguard\/reference-before\.json --reference-after \.testguard\/reference-after\.json --report-only/);
  });
});
