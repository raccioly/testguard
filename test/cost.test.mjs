// @req NFR-05
// @req NFR-06
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runsOf, recordCost, claimCosts, defenderCosts, costReport, renderCost, checkCostBudget, renderCostBudget } from '../src/probe/cost.mjs';

const run = (durationMs) => ({ outcome: 'pass', durationMs });
/** An evidence record, reduced to the parts cost is derived from. */
const rec = (claimId, faultId, defenders, { baseline = [], probe = [], escalation = [], reusedFrom } = {}) => ({
  claim: { id: claimId },
  subject: { id: faultId },
  verdict: 'killed',
  defenders: { requested: defenders, resolved: defenders, nocover: false },
  detail: { baselineRuns: baseline, probeRuns: probe, escalationRuns: escalation },
  ...(reusedFrom ? { reusedFrom } : {}),
});

describe('recordCost', () => {
  it('sums every phase the probe paid for, not just the fault runs', () => {
    const r = rec('C1', 'F1', ['a.test.mjs'], { baseline: [run(100), run(100)], probe: [run(50)], escalation: [run(25)] });
    expect(recordCost(r)).toEqual({ ms: 275, runs: 4, reused: false });
    expect(runsOf(r)).toHaveLength(4);
  });

  it('is zero-safe on a record with no runs and on runs with no duration', () => {
    expect(recordCost({ claim: { id: 'C' }, detail: {} })).toEqual({ ms: 0, runs: 0, reused: false });
    expect(recordCost(rec('C', 'F', [], { probe: [{ outcome: 'error' }] }))).toEqual({ ms: 0, runs: 1, reused: false });
  });

  it('marks a reused record, because its runs are not wall clock just spent', () => {
    expect(recordCost(rec('C', 'F', ['a.test.mjs'], { probe: [run(900)], reusedFrom: 'run-1' })).reused).toBe(true);
  });
});

describe('claimCosts', () => {
  const records = [
    rec('CHEAP', 'F1', ['fast.test.mjs'], { probe: [run(10)] }),
    rec('DEAR', 'F1', ['slow.test.mjs'], { probe: [run(1000)] }),
    rec('DEAR', 'F2', ['slow.test.mjs'], { probe: [run(1000)], reusedFrom: 'run-1' }),
  ];

  it('rolls faults up to their claim, most expensive first', () => {
    const [first, second] = claimCosts(records);
    expect(first).toMatchObject({ claimId: 'DEAR', ms: 2000, faults: 2, runs: 2, reused: 1, defenders: ['slow.test.mjs'] });
    expect(second).toMatchObject({ claimId: 'CHEAP', ms: 10, faults: 1 });
  });

  it('breaks ties by id so two runs of the same evidence report the same order', () => {
    const tied = [rec('B', 'F1', [], { probe: [run(5)] }), rec('A', 'F1', [], { probe: [run(5)] })];
    expect(claimCosts(tied).map((c) => c.claimId)).toEqual(['A', 'B']);
  });
});

describe('defenderCosts', () => {
  it('charges a file for every run that included it, and names the claims that did', () => {
    const [top] = defenderCosts([
      rec('C1', 'F1', ['shared.test.mjs', 'unit.test.mjs'], { probe: [run(500)] }),
      rec('C2', 'F1', ['shared.test.mjs'], { probe: [run(500)] }),
    ]);
    expect(top).toMatchObject({ file: 'shared.test.mjs', ms: 1000, runs: 2, claims: ['C1', 'C2'] });
  });

  it('counts a set-run against every file in the set, so the figures overlap the total rather than dividing it', () => {
    // One 600ms run, two defenders. Neither file can be said to have cost 300ms:
    // the only thing the runner measured is that the SET took 600ms.
    const report = costReport([rec('C1', 'F1', ['a.test.mjs', 'b.test.mjs'], { probe: [run(600)] })]);
    expect(report.totalMs).toBe(600);
    expect(report.defenders.map((d) => d.ms)).toEqual([600, 600]);
  });

  it('ignores records with no resolved defenders rather than inventing a file for them', () => {
    expect(defenderCosts([rec('C', 'F', [], { probe: [run(100)] })])).toEqual([]);
  });
});

describe('costReport', () => {
  const records = [
    rec('C1', 'F1', ['fixture.test.mjs'], { baseline: [run(50_000)], probe: [run(50_000)] }),
    rec('C2', 'F1', ['fixture.test.mjs'], { probe: [run(50_000)] }),
    rec('C3', 'F1', ['unit.test.mjs'], { probe: [run(400)] }),
  ];

  it('names the file more than one claim pays for — the whole point of the report', () => {
    const r = costReport(records);
    expect(r.sharedDefenders).toHaveLength(1);
    expect(r.sharedDefenders[0]).toMatchObject({ file: 'fixture.test.mjs', claims: ['C1', 'C2'] });
  });

  it('does not call a file shared when one claim names it for several faults', () => {
    const r = costReport([rec('C1', 'F1', ['x.test.mjs'], { probe: [run(1)] }), rec('C1', 'F2', ['x.test.mjs'], { probe: [run(1)] })]);
    expect(r.sharedDefenders).toEqual([]);
  });

  it('totals only the additive numbers', () => {
    const r = costReport(records);
    expect(r.totalMs).toBe(150_400);
    expect(r.totalRuns).toBe(4);
    expect(r.records).toBe(3);
  });
});

describe('renderCost', () => {
  it('says so plainly when there is no evidence, instead of printing an empty report', () => {
    expect(renderCost(costReport([]))).toMatch(/no evidence records/);
  });

  it('leads with the total, then names the shared defender and what to do about it', () => {
    const text = renderCost(costReport([
      rec('C1', 'F1', ['fixture.test.mjs'], { probe: [run(50_000)] }),
      rec('C2', 'F1', ['fixture.test.mjs'], { probe: [run(50_000)] }),
    ]));
    expect(text).toContain('2 fault records cost 100s across 2 defender runs');
    expect(text).toContain('shared defenders');
    expect(text).toContain('named by C1, C2');
    expect(text).toMatch(/split the behaviour a shared defender proves/);
  });

  it('warns that per-file figures overlap, so nobody adds them up', () => {
    expect(renderCost(costReport([rec('C', 'F', ['a.test.mjs'], { probe: [run(1)] })]))).toMatch(/overlap and do not sum to the total/);
  });

  it('truncates long lists but never the totals', () => {
    const many = Array.from({ length: 12 }, (_, i) => rec(`C${i}`, 'F1', [`t${i}.test.mjs`], { probe: [run(1000)] }));
    const text = renderCost(costReport(many), { limit: 3 });
    expect(text).toContain('12 fault records cost 12s');
    expect(text).toContain('… 9 more');
  });
});

describe('checkCostBudget — the gate has to gate on its own cost', () => {
  const report = (totalMs, claims = []) => ({ totalMs, totalRuns: 100, records: 50, claims, defenders: [] });

  it('passes inside the budget and reports the headroom', () => {
    const d = checkCostBudget(report(804_000), { budgetSeconds: 950 });
    expect(d).toMatchObject({ ok: true, totalMs: 804_000, budgetMs: 950_000, overByMs: 0, headroomMs: 146_000 });
  });

  it('fails over the budget and says by how much', () => {
    const d = checkCostBudget(report(804_000), { budgetSeconds: 700 });
    expect(d).toMatchObject({ ok: false, overByMs: 104_000, headroomMs: 0 });
  });

  it('is inclusive at the boundary — exactly on budget is inside it', () => {
    expect(checkCostBudget(report(900_000), { budgetSeconds: 900 }).ok).toBe(true);
    expect(checkCostBudget(report(900_001), { budgetSeconds: 900 }).ok).toBe(false);
  });

  it('names the worst claims, so a failure opens with where to look', () => {
    // claimCosts emits `claimId`, not `id`. This test once fed the shape the code
    // wished for and passed while CI printed "undefined" for every claim.
    const d = checkCostBudget(report(999_000, [
      { claimId: 'A', ms: 71_000, runs: 12 }, { claimId: 'B', ms: 64_000, runs: 6 }, { claimId: 'C', ms: 30_000, runs: 6 },
    ]), { budgetSeconds: 100, worst: 2 });
    expect(d.worst).toEqual([{ id: 'A', ms: 71_000, runs: 12 }, { id: 'B', ms: 64_000, runs: 6 }]);
    expect(renderCostBudget(d)).toMatch(/most expensive claims[\s\S]*\sA\s+\(12 runs\)/);
  });

  it('names them from a real report, never a hand-built one', () => {
    const d = checkCostBudget(costReport([
      rec('DEAR', 'F1', ['slow.test.mjs'], { probe: [run(1000)] }),
      rec('CHEAP', 'F1', ['fast.test.mjs'], { probe: [run(10)] }),
    ]), { budgetSeconds: 0.5 });
    expect(d.ok).toBe(false);
    expect(d.worst.map((c) => c.id)).toEqual(['DEAR', 'CHEAP']);
    expect(renderCostBudget(d)).not.toMatch(/undefined/);
  });

  it('reports a delta when a previous run is given, and works without one', () => {
    expect(checkCostBudget(report(804_000), { budgetSeconds: 950, previousMs: 780_000 }).deltaMs).toBe(24_000);
    const none = checkCostBudget(report(804_000), { budgetSeconds: 950 });
    expect(none.deltaMs).toBeUndefined();
    expect(none.ok).toBe(true); // a missing baseline never fails the check
  });

  // The regression this exists to catch: 59 -> 91 faults, per-fault cost flat.
  // An average would have reported everything fine while the gate tripled.
  it('catches growth that a per-fault average would hide', () => {
    const before = checkCostBudget(report(9.6 * 60_000), { budgetSeconds: 950 });
    const after = checkCostBudget(report(23.6 * 60_000), { budgetSeconds: 950 });
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
  });

  it('refuses a budget that is not a positive number, rather than passing everything', () => {
    for (const bad of [undefined, 0, -1, NaN, '900']) {
      expect(() => checkCostBudget(report(1), { budgetSeconds: bad })).toThrow(TypeError);
    }
  });
});

describe('the per-claim ceiling — what the total absorbs silently', () => {
  // Neither unit works alone. The total can only ever be raised, because claims
  // should grow forever, so a number that always goes up stops being read. A
  // per-fault average is worse: the regression that prompted this budget raised
  // the fault count 59 -> 91 while per-fault cost barely moved.
  //
  // The measured pathology is per-CLAIM, and specifically a claim naming an
  // expensive SHARED defender file, since a claim pays for every test in the
  // file it names. A calibration claim landed at 51 s for two faults purely by
  // being written into replay.test.mjs rather than calibration.test.mjs;
  // re-pointing it took it to 4.9 s, and the total never noticed.
  const report = (totalMs, claims = []) => ({ totalMs, claims, defenders: [] });
  const pig = [{ claimId: 'TG-PIG', ms: 80_000, runs: 6 }, { claimId: 'TG-FINE', ms: 5_000, runs: 6 }];

  it('fails a claim over the ceiling even when the total is comfortably inside it', () => {
    const d = checkCostBudget(report(100_000, pig), { budgetSeconds: 1230, perClaimSeconds: 75 });
    expect(d.ok).toBe(false);                       // the total is fine; the claim is not
    expect(d.totalMs).toBeLessThan(d.budgetMs);
    expect(d.overPerClaim.map((c) => c.id)).toEqual(['TG-PIG']);
  });

  it('names the claim and its remedy, which is a cheaper defender rather than a bigger budget', () => {
    const text = renderCostBudget(checkCostBudget(report(100_000, pig), { budgetSeconds: 1230, perClaimSeconds: 75 }));
    expect(text).toMatch(/PER-CLAIM BUDGET EXCEEDED: 1 claim over the 75s per-claim ceiling/);
    expect(text).toContain('TG-PIG');
    expect(text).not.toContain('TG-FINE');
    expect(text).toMatch(/pays for every test in the file it names/);
    // The total is inside its budget and must still say so, not be overwritten
    // by the per-claim failure: two ceilings, two findings.
    expect(text).toMatch(/^cost .* to spare/m);
    expect(text).not.toContain('COST BUDGET EXCEEDED');
  });

  it('reports both when the total and a claim are over', () => {
    const text = renderCostBudget(checkCostBudget(report(2_000_000, pig), { budgetSeconds: 1230, perClaimSeconds: 75 }));
    expect(text).toContain('COST BUDGET EXCEEDED');
    expect(text).toContain('PER-CLAIM BUDGET EXCEEDED');
  });

  it('is exactly at-or-under, like the total', () => {
    expect(checkCostBudget(report(1, [{ claimId: 'X', ms: 75_000, runs: 6 }]), { budgetSeconds: 1230, perClaimSeconds: 75 }).ok).toBe(true);
    expect(checkCostBudget(report(1, [{ claimId: 'X', ms: 75_001, runs: 6 }]), { budgetSeconds: 1230, perClaimSeconds: 75 }).ok).toBe(false);
  });

  it('is optional: a budget with no per-claim ceiling behaves exactly as before', () => {
    // The field is additive. An older budget file, or another project's, must
    // not start failing because this ceiling exists.
    const d = checkCostBudget(report(100_000, pig), { budgetSeconds: 1230 });
    expect(d.ok).toBe(true);
    expect(d.perClaimMs).toBeUndefined();
    expect(d.overPerClaim).toBeUndefined();
    expect(renderCostBudget(d)).not.toContain('PER-CLAIM');
  });

  it("this project's own budget sits just above its worst claim, so the rule stays meaningful", () => {
    // The ceiling is "no new claim may be worse than the worst we already
    // have". A ceiling far above the worst would gate nothing.
    const budget = JSON.parse(readFileSync(new URL('../testguard.cost-budget.json', import.meta.url), 'utf8'));
    expect(budget.perClaimSeconds).toBeGreaterThan(budget.perClaim.todayWorst.seconds);
    expect(budget.perClaimSeconds).toBeLessThan(budget.perClaim.todayWorst.seconds * 1.5);
    expect(budget.seconds).toBeGreaterThan(budget.measuredInCI.seconds);
  });
});
