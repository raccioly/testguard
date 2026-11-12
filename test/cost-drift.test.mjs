// Defect E of the 0.22.1 verification: the speed factor was the MEAN of the
// reference medians taken before and after the probe. A runner that slowed
// down mid-run (170 ms, then 320 ms: 1.88x, flagged low confidence) was
// credited for the average, so 3900 raw seconds normalized to 3184 and passed
// a 3600 ceiling although at the faster reading the same work costs 4588. A run
// whose speed moved is compared at the pessimistic reading, and says so.
import { describe, it, expect } from 'vitest';
import { assessReference, checkCostBudget, renderCostBudget } from '../src/probe/cost.mjs';

const CLASS = { cpus: 4, platform: 'linux' };
const ref = (beforeMs, afterMs) => ({ beforeMs, afterMs, baselineMs: 200, runner: { baseline: CLASS, before: CLASS, after: CLASS } });
const report = (seconds) => ({ totalMs: seconds * 1000, claims: [{ claimId: 'C1', ms: 40_000, runs: 6 }], reusedRecords: 0 });
const CEILING = { budgetSeconds: 3600, perClaimSeconds: 100 };

describe('a runner whose speed drifted mid-run cannot hide growth', () => {
  it('fails the reported scenario: 170 ms before, 320 ms after, 3900 raw seconds against 3600', () => {
    const d = checkCostBudget(report(3900), { ...CEILING, reference: ref(170, 320) });
    expect(d.ok).toBe(false);
    expect(d.failures).toContain('over-budget');
    expect(d.failures).toContain('low-confidence-over-ceiling');
    // the faster reading: 170 / 200 = 0.85, so 3900 / 0.85
    expect(d.reference.speedFactor).toBeCloseTo(0.85, 10);
    expect(d.totalMs / 1000).toBeCloseTo(4588.2, 1);
    expect(d.reference.factorBasis).toBe('pessimistic');
    expect(d.reference.meanFactor).toBeCloseTo(1.225, 10);
  });

  it('takes the faster reading whichever batch it was: after faster than before is pessimistic too', () => {
    const d = checkCostBudget(report(3900), { ...CEILING, reference: ref(320, 170) });
    expect(d.ok).toBe(false);
    expect(d.reference.speedFactor).toBeCloseTo(0.85, 10);
  });

  it('the same raw seconds on a stable runner (245 ms both times) keep the mean and pass', () => {
    const d = checkCostBudget(report(3900), { ...CEILING, reference: ref(245, 245) });
    expect(d.ok).toBe(true);
    expect(d.reference.lowConfidence).toBe(false);
    expect(d.reference.factorBasis).toBe('mean');
    expect(d.reference.speedFactor).toBeCloseTo(1.225, 10);
    expect(d.totalMs / 1000).toBeCloseTo(3183.7, 1);
  });

  it('a drift inside the limit is not pessimistic: the mean is still the factor', () => {
    const a = assessReference(ref(200, 300)); // drift 1.5, exactly the limit
    expect(a.lowConfidence).toBe(false);
    expect(a.factorBasis).toBe('mean');
    expect(a.speedFactor).toBeCloseTo(1.25, 10);
    expect(assessReference(ref(200, 301)).factorBasis).toBe('pessimistic');
  });

  it('a drifted run that is comfortably inside the ceiling at the faster reading still passes', () => {
    const d = checkCostBudget(report(1000), { ...CEILING, reference: ref(170, 320) });
    expect(d.ok).toBe(true);
    expect(d.reference.factorBasis).toBe('pessimistic');
  });

  it('says in the output which reading it used and why', () => {
    const text = renderCostBudget(checkCostBudget(report(3900), { ...CEILING, reference: ref(170, 320) }));
    expect(text).toMatch(/pessimistic/i);
    expect(text).toMatch(/faster reading/);
    expect(text).toMatch(/mean would be 1\.23/);
    const stable = renderCostBudget(checkCostBudget(report(3900), { ...CEILING, reference: ref(245, 245) }));
    expect(stable).not.toMatch(/pessimistic/i);
  });

  it('reused records alone keep the mean: only a drifted speed is read pessimistically', () => {
    const a = assessReference(ref(245, 245), { reusedRecords: 3 });
    expect(a.lowConfidenceReasons).toEqual(['reused-records']);
    expect(a.factorBasis).toBe('mean');
  });
});
