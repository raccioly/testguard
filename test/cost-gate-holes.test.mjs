// Holes found by hand-made wrong builds of the cost gate: each assertion here
// failed to fail when one line was broken.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessReference, checkCostBudget } from '../src/probe/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(readFileSync(join(ROOT, 'testguard.cost-budget.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'tg-cost-holes-'));
const write = (name, value) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
const CLASS = { cpus: budget.reference.cpus, platform: budget.reference.platform };
const measurement = write('ref.json', { workload: budget.reference.workload, medianMs: budget.reference.baselineMs, ...CLASS });
const oneClaim = (seconds) => write(`one-${seconds}.json`, { run: { measurements: { elapsedMs: seconds * 1000 }, ...(budget.faultWorkers > 1 ? { faultWorkers: budget.faultWorkers } : {}) }, records: [{ claim: { id: 'BIG-CLAIM' }, subject: { id: 'F1' }, defenders: { resolved: ['a.test.mjs'] }, detail: { baselineRuns: [], probeRuns: [{ durationMs: seconds * 1000 }] } }] });
const gate = (evidence) => spawnSync(process.execPath, [join(ROOT, '.github/scripts/check-cost-budget.mjs'), evidence, '--reference-before', measurement, '--reference-after', measurement], { encoding: 'utf8', cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

describe('J: the per-claim ceiling is wired into the script', () => {
  it('one claim over perClaimSeconds, with the total far under budget, exits 1 and says so', () => {
    const over = budget.perClaimSeconds + 20;
    expect(over).toBeLessThan(budget.seconds);
    const r = gate(oneClaim(over));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PER-CLAIM BUDGET EXCEEDED');
    expect(r.stdout).toContain('BIG-CLAIM');
    expect(r.stdout).toMatch(/"failures":\["per-claim-over-ceiling"\]/);
  });

  it('the same claim at the ceiling passes', () => {
    expect(gate(oneClaim(budget.perClaimSeconds - 1)).status).toBe(0);
  });
});

const CLS = { cpus: 4, platform: 'linux' };
const ref = (beforeMs, afterMs = beforeMs) => ({ beforeMs, afterMs, baselineMs: 1000, runner: { baseline: CLS, before: CLS, after: CLS } });
const claim = (claimId, seconds) => ({ claimId, ms: seconds * 1000, runs: 6 });
const CEILING = { budgetSeconds: 3000, perClaimSeconds: 100 };

describe('K: exactly one reused record makes a run low confidence', () => {
  it('one reused record is enough; none is not', () => {
    expect(assessReference(ref(1000), { reusedRecords: 1 })).toMatchObject({ lowConfidence: true, lowConfidenceReasons: ['reused-records'] });
    expect(assessReference(ref(1000), { reusedRecords: 0 }).lowConfidence).toBe(false);
    const d = checkCostBudget({ totalMs: 4000_000, claims: [], reusedRecords: 1 }, { ...CEILING, reference: ref(1000) });
    expect(d.failures).toContain('low-confidence-over-ceiling');
  });
});

describe('O: the reported numbers and the failure list say what happened', () => {
  it('an out-of-range reference leaves the total unnormalized and says so', () => {
    const d = checkCostBudget({ totalMs: 1_000_000, claims: [claim('C1', 50)], reusedRecords: 0 }, { ...CEILING, reference: ref(4000) });
    expect(d.reference.status).toBe('out-of-range');
    expect(d.basis).toBe('unnormalized');
    expect(d.totalMs).toBe(d.rawMs);
    expect(d.worst[0].ms).toBe(50_000);
    expect(d.failures).toEqual(['reference-out-of-range']);
  });

  it('a low-confidence run over only the per-claim ceiling names the low confidence too', () => {
    const d = checkCostBudget({ totalMs: 500_000, claims: [claim('BIG', 300)], reusedRecords: 1 }, { ...CEILING, reference: ref(1000) });
    expect(d.totalMs).toBeLessThan(d.budgetMs);
    expect(d.failures).toEqual(['per-claim-over-ceiling', 'low-confidence-over-ceiling']);
  });

  it('a confident run over only the per-claim ceiling does not claim low confidence', () => {
    const d = checkCostBudget({ totalMs: 500_000, claims: [claim('BIG', 300)], reusedRecords: 0 }, { ...CEILING, reference: ref(1000) });
    expect(d.failures).toEqual(['per-claim-over-ceiling']);
  });
});
