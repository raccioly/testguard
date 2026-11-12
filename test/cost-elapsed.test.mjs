// raccioly/testguard#284: the self-probe cost gate compares normalized ELAPSED
// time, valid only for the fault-worker count it was measured at. Summed
// defender seconds rise when faults run side by side while the job gets
// faster, so the sum is reported and never gated; the per-claim ceiling stays.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCostBudget, renderCostBudget } from '../src/probe/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
const CLASS = { cpus: 4, platform: 'linux' };
const reference = { beforeMs: 200, afterMs: 200, baselineMs: 200, runner: { baseline: CLASS, before: CLASS, after: CLASS } };
const report = (summedSeconds, claims = []) => ({ totalMs: summedSeconds * 1000, records: 700, reusedRecords: 0, claims });
const elapsed = (seconds, faultWorkers = 2) => ({ elapsedMs: seconds * 1000, faultWorkers });
const CEILING = { budgetSeconds: 2000, budgetFaultWorkers: 2, perClaimSeconds: 100 };

describe('the ceiling is on elapsed time', () => {
  it('elapsed over the ceiling fails, naming elapsed time', () => {
    const d = checkCostBudget(report(3000), { ...CEILING, reference, ...elapsed(2100) });
    expect(d.ok).toBe(false);
    expect(d.failures).toEqual(['over-budget']);
    expect(d.basis).toBe('normalized-elapsed');
    expect(d.totalMs).toBe(2100_000);
    expect(renderCostBudget(d)).toMatch(/^COST BUDGET EXCEEDED: normalized elapsed 2100s against a 2000s budget, over by 100s/);
  });

  it('a sum far over, with elapsed under, passes: the sum is reported, not gated', () => {
    const d = checkCostBudget(report(9000), { ...CEILING, reference, ...elapsed(1800) });
    expect(d.ok).toBe(true);
    expect(d.failures).toEqual([]);
    expect(d.summedMs).toBe(9000_000);
    const text = renderCostBudget(d);
    expect(text).toMatch(/^cost normalized elapsed 1800s of a 2000s budget/);
    expect(text).toMatch(/summed defender seconds 9000s \(reported, not gated; inflated by overlap at 2 fault workers, #284\)/);
  });

  it('a run at another fault-worker count fails closed, with the reason named', () => {
    const d = checkCostBudget(report(100), { ...CEILING, reference, ...elapsed(100, 4) });
    expect(d.ok).toBe(false);
    expect(d.failures).toEqual(['fault-workers-mismatch']);
    expect(renderCostBudget(d)).toMatch(/^COST FAULT-WORKER MISMATCH: this run probed 4 faults at a time; the ceiling is valid only for 2/);
    // An elapsed figure with no recorded width cannot be judged either.
    expect(checkCostBudget(report(100), { ...CEILING, reference, elapsedMs: 100_000 }).failures).toEqual(['fault-workers-mismatch']);
  });

  it('a ceiling in elapsed seconds and evidence with no elapsed time is a unit error: fails closed, never compares the sum', () => {
    const d = checkCostBudget(report(100), { ...CEILING, unit: 'normalized-elapsed-seconds', reference });
    expect(d.failures).toEqual(['elapsed-missing']);
    expect(renderCostBudget(d)).toMatch(/^COST ELAPSED TIME MISSING/);
  });

  it('the per-claim ceiling stays a gate on summed seconds', () => {
    const d = checkCostBudget(report(500, [{ claimId: 'BIG', ms: 150_000, runs: 6 }]), { ...CEILING, reference, ...elapsed(500) });
    expect(d.failures).toEqual(['per-claim-over-ceiling']);
  });

  it('elapsed time is normalized like the sum: a slow runner is not growth', () => {
    const slow = { ...reference, beforeMs: 300, afterMs: 300 };
    const d = checkCostBudget(report(100), { ...CEILING, reference: slow, ...elapsed(2700) });
    expect(d.totalMs).toBe(1800_000);
    expect(d.ok).toBe(true);
  });
});

describe('the script gates on the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cost-elapsed-'));
  const write = (name, value) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const ref = write('ref.json', { workload: budget.reference.workload, medianMs: budget.reference.baselineMs, cpus: budget.reference.cpus, platform: budget.reference.platform });
  const evidence = (elapsedSeconds, faultWorkers, summedSeconds) => write(`e-${elapsedSeconds}-${faultWorkers}.json`, {
    run: { measurements: { elapsedMs: elapsedSeconds * 1000 }, ...(faultWorkers > 1 ? { faultWorkers } : {}) },
    records: [{ claim: { id: 'SMALL' }, subject: { id: 'F1' }, defenders: { resolved: ['a.test.mjs'] }, detail: { baselineRuns: [], probeRuns: [{ durationMs: summedSeconds * 1000 }] } }],
  });
  const gate = (path) => spawnSync(process.execPath, [join(ROOT, '.github/scripts/check-cost-budget.mjs'), path, '--reference-before', ref, '--reference-after', ref], { encoding: 'utf8', cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

  it('the file states its unit and the width its ceiling is valid for', () => {
    expect(budget.unit).toBe('normalized-elapsed-seconds');
    expect(Number.isInteger(budget.faultWorkers)).toBe(true);
  });

  it('elapsed under the ceiling passes however large the sum; over it fails; another width fails closed', () => {
    const under = gate(evidence(budget.seconds - 100, budget.faultWorkers, 90));
    expect(under.status, under.stdout).toBe(0);
    const over = gate(evidence(budget.seconds + 100, budget.faultWorkers, 10));
    expect(over.status).toBe(1);
    expect(over.stdout).toMatch(/"failures":\["over-budget"\]/);
    const other = gate(evidence(10, budget.faultWorkers + 1, 10));
    expect(other.status).toBe(1);
    expect(other.stdout).toMatch(/"failures":\["fault-workers-mismatch"\]/);
  });
});
