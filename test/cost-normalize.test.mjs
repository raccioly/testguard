// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { median, assessReference, referenceFrom, normalize, checkCostBudget, renderCostBudget, REFERENCE_FACTOR_RANGE, REFERENCE_MAX_DRIFT } from '../src/probe/cost.mjs';

// Issue #255: the same 592 faults measured 2876 s, 2901 s, 3366 s and 4159 s on
// four CI runs. The ceiling must follow the suite, not the runner. A reference
// workload is timed immediately before and after the probe; its median, against
// a recorded baseline, is the runner's speed factor.
const BASELINE = 1000;
const CLASS = { cpus: 4, platform: 'linux' };
const ref = (beforeMs, afterMs = beforeMs, extra = {}) => ({ beforeMs, afterMs, baselineMs: BASELINE, runner: { baseline: CLASS, before: CLASS, after: CLASS }, ...extra });
const report = (totalSeconds, claims = [], extra = {}) => ({ totalMs: totalSeconds * 1000, claims, reusedRecords: 0, ...extra });
const claim = (claimId, seconds) => ({ claimId, ms: seconds * 1000, runs: 6 });
const CEILING = { budgetSeconds: 3000, perClaimSeconds: 100 };

describe('median', () => {
  it('takes the middle of an odd batch and the mean of the middle two of an even one, whatever the order', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([7])).toBe(7);
  });

  it('refuses an empty batch and a batch with a value that is not a finite number', () => {
    expect(() => median([])).toThrow(TypeError);
    expect(() => median([1, Number.NaN])).toThrow(TypeError);
    expect(() => median([1, Infinity])).toThrow(TypeError);
    expect(() => median([1, '2'])).toThrow(TypeError);
  });

  it('does not reorder the caller\'s array', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('normalize', () => {
  it('divides by the speed factor: a slow runner (factor > 1) is credited, a fast one (< 1) is charged', () => {
    expect(normalize(3000, 1.5)).toBe(2000);
    expect(normalize(3000, 0.5)).toBe(6000);
    expect(normalize(3000, 1)).toBe(3000);
  });

  it('refuses a factor that is not a positive finite number rather than dividing by it', () => {
    for (const bad of [0, -1, Number.NaN, Infinity, undefined, '1.2']) expect(() => normalize(10, bad)).toThrow(TypeError);
  });
});

describe('assessReference', () => {
  it('derives the factor from the mean of the before and after medians over the recorded baseline', () => {
    const a = assessReference(ref(1100, 1300));
    expect(a).toMatchObject({ status: 'ok', beforeMs: 1100, afterMs: 1300, baselineMs: 1000, lowConfidence: false });
    expect(a.speedFactor).toBeCloseTo(1.2, 10);
    expect(a.drift).toBeCloseTo(1300 / 1100, 10);
  });

  it('is missing, never a default of 1, when either median or the baseline is absent or not a positive number', () => {
    const cases = [undefined, null, {}, ref(undefined), { beforeMs: 1000, baselineMs: BASELINE }, ref(0), ref(1000, -5), ref(Number.NaN), ref(1000, 1000, { baselineMs: undefined }), ref(1000, 1000, { baselineMs: 0 }), ref('1000')];
    for (const c of cases) expect(assessReference(c)).toMatchObject({ status: 'missing' });
  });

  it('is out of range below the lower bound and above the upper bound, and in range exactly on them', () => {
    const [lo, hi] = REFERENCE_FACTOR_RANGE;
    expect(assessReference(ref(BASELINE * lo * 0.99))).toMatchObject({ status: 'out-of-range' });
    expect(assessReference(ref(BASELINE * hi * 1.01))).toMatchObject({ status: 'out-of-range' });
    expect(assessReference(ref(BASELINE * lo))).toMatchObject({ status: 'ok' });
    expect(assessReference(ref(BASELINE * hi))).toMatchObject({ status: 'ok' });
  });

  it('honors a range given with the budget file instead of the default', () => {
    expect(assessReference(ref(1800), undefined)).toMatchObject({ status: 'ok' });
    expect(assessReference(ref(1800, 1800, { factorRange: [0.8, 1.5] }))).toMatchObject({ status: 'out-of-range' });
  });

  it('flags low confidence when the runner moved between the two batches by more than the stated factor, in either direction', () => {
    expect(assessReference(ref(1000, 1000 * REFERENCE_MAX_DRIFT))).toMatchObject({ status: 'ok', lowConfidence: false });
    expect(assessReference(ref(1000, 1000 * REFERENCE_MAX_DRIFT * 1.01))).toMatchObject({ status: 'ok', lowConfidence: true });
    expect(assessReference(ref(1000 * REFERENCE_MAX_DRIFT * 1.01, 1000))).toMatchObject({ status: 'ok', lowConfidence: true });
    expect(assessReference(ref(1000, 1400, { maxDrift: 1.2 }))).toMatchObject({ lowConfidence: true });
  });

  it('flags low confidence when verdicts were reused, because their durations were measured on another runner', () => {
    expect(assessReference(ref(1000), { reusedRecords: 3 })).toMatchObject({ status: 'ok', lowConfidence: true, lowConfidenceReasons: ['reused-records'] });
    expect(assessReference(ref(1000), { reusedRecords: 0 }).lowConfidenceReasons).toEqual([]);
  });
});

describe('checkCostBudget with a reference', () => {
  it('keeps the raw comparison when no reference is asked for, and says so', () => {
    const d = checkCostBudget(report(2900), CEILING);
    expect(d).toMatchObject({ ok: true, basis: 'raw', totalMs: 2_900_000 });
    expect(d.reference).toBeUndefined();
  });

  it('a slow runner with unchanged work passes: raw seconds over the ceiling, normalized under it', () => {
    // 3600 s raw against a 3000 s ceiling, on a runner 1.4x slower than baseline: 2571 s of work.
    const d = checkCostBudget(report(3600), { ...CEILING, reference: ref(1400) });
    expect(d.ok).toBe(true);
    expect(d).toMatchObject({ basis: 'normalized', rawMs: 3_600_000 });
    expect(d.totalMs).toBeCloseTo(3_600_000 / 1.4, 3);
    expect(d.reference.speedFactor).toBeCloseTo(1.4, 10);
    expect(d.failures).toEqual([]);
  });

  it('a fast runner cannot hide real growth: raw seconds under the ceiling, normalized over it', () => {
    // 2700 s raw is under 3000, but the runner is 0.7x the baseline time: 3857 s of work.
    const d = checkCostBudget(report(2700), { ...CEILING, reference: ref(700) });
    expect(d.ok).toBe(false);
    expect(d.failures).toEqual(['over-budget']);
    expect(d.totalMs).toBeGreaterThan(d.budgetMs);
    expect(d.overByMs).toBeCloseTo(2_700_000 / 0.7 - 3_000_000, 3);
  });

  it('fails closed when the reference is absent, and does not fall back to the raw seconds even when they are under the ceiling', () => {
    for (const reference of [null, {}, ref(undefined), { beforeMs: 1000, baselineMs: BASELINE }, ref(1000, 1000, { baselineMs: undefined })]) {
      const d = checkCostBudget(report(100), { ...CEILING, reference });
      expect(d.ok).toBe(false);
      expect(d.failures).toEqual(['reference-missing']);
      expect(d.basis).toBe('unnormalized');
      expect(d.rawMs).toBe(100_000);
    }
  });

  it('fails closed on an absurd factor, in both directions, even when the work is far under the ceiling', () => {
    for (const afterMs of [BASELINE * 0.4, BASELINE * 3]) {
      const d = checkCostBudget(report(100), { ...CEILING, reference: ref(afterMs) });
      expect(d.ok).toBe(false);
      expect(d.failures).toEqual(['reference-out-of-range']);
    }
  });

  it('a low-confidence run that is over the ceiling fails and says which, while one under it passes with the warning', () => {
    const drifting = ref(900, 1600); // drift 1.78: read at the faster 900 ms, factor 0.9 (the mean would be 1.25)
    const over = checkCostBudget(report(4000), { ...CEILING, reference: drifting });
    expect(over.ok).toBe(false);
    expect(over.failures).toEqual(['over-budget', 'low-confidence-over-ceiling']);
    const under = checkCostBudget(report(2500), { ...CEILING, reference: drifting });
    expect(under).toMatchObject({ ok: true, failures: [] });
    expect(under.reference.lowConfidence).toBe(true);
  });

  it('a confident run over the ceiling fails as over-budget only', () => {
    const d = checkCostBudget(report(4000), { ...CEILING, reference: ref(1000) });
    expect(d.failures).toEqual(['over-budget']);
  });

  it('reused verdicts make the run low-confidence', () => {
    const d = checkCostBudget(report(4000, [], { reusedRecords: 2 }), { ...CEILING, reference: ref(1000) });
    expect(d.failures).toEqual(['over-budget', 'low-confidence-over-ceiling']);
    expect(d.reference.lowConfidenceReasons).toEqual(['reused-records']);
  });

  it('normalizes the per-claim ceiling the same way', () => {
    const claims = [claim('SLOW-HOST-OK', 120), claim('FAST-HOST-HIDES', 90)];
    // factor 1.3: 120 s raw is 92 s of work, under 100.
    const slow = checkCostBudget(report(200, [claims[0]]), { ...CEILING, reference: ref(1300) });
    expect(slow.overPerClaim).toEqual([]);
    expect(slow.ok).toBe(true);
    // factor 0.8: 90 s raw is 112 s of work, over 100.
    const fast = checkCostBudget(report(200, [claims[1]]), { ...CEILING, reference: ref(800) });
    expect(fast.ok).toBe(false);
    expect(fast.failures).toEqual(['per-claim-over-ceiling']);
    expect(fast.overPerClaim).toEqual([expect.objectContaining({ id: 'FAST-HOST-HIDES', rawMs: 90_000 })]);
    expect(fast.overPerClaim[0].ms).toBeCloseTo(112_500, 3);
  });

  it('keeps the worst list in the units the ceiling is in', () => {
    const d = checkCostBudget(report(2800, [claim('A', 80)]), { ...CEILING, reference: ref(800) });
    expect(d.worst[0]).toMatchObject({ id: 'A', rawMs: 80_000 });
    expect(d.worst[0].ms).toBeCloseTo(100_000, 3);
  });
});

describe('renderCostBudget with a reference', () => {
  const text = (rep, opts) => renderCostBudget(checkCostBudget(rep, { ...CEILING, ...opts }));

  it('always prints the raw seconds, both reference medians, the baseline, the factor and the normalized seconds', () => {
    const out = text(report(3600), { reference: ref(1300, 1500) });
    expect(out).toContain('raw 3600s');
    expect(out).toContain('before 1.3s');
    expect(out).toContain('after 1.5s');
    expect(out).toContain('baseline 1.0s');
    expect(out).toContain('speed factor 1.40');
    expect(out).toMatch(/normalized 2571s/);
  });

  it('names a missing reference as the reason, not the budget', () => {
    const out = text(report(100), { reference: null });
    expect(out.split('\n')[0]).toMatch(/^COST REFERENCE MISSING/);
    expect(out).toContain('raw 100s');
    expect(out).not.toMatch(/to spare/);
  });

  it('names an out-of-range factor and the range it was held to', () => {
    const out = text(report(100), { reference: ref(3000) });
    expect(out.split('\n')[0]).toMatch(/^COST REFERENCE OUT OF RANGE.*3\.00/);
    expect(out).toContain(`${REFERENCE_FACTOR_RANGE[0]}`);
    expect(out).toContain(`${REFERENCE_FACTOR_RANGE[1]}`);
  });

  it('names a low-confidence failure and says the runner moved during the probe', () => {
    const out = text(report(4000), { reference: ref(900, 1600) });
    expect(out).toMatch(/LOW-CONFIDENCE/);
    expect(out).toMatch(/moved|drift/);
    expect(out).toMatch(/COST BUDGET EXCEEDED/);
  });

  it('prints the low-confidence warning on a pass, so it is not silent', () => {
    expect(text(report(3000), { reference: ref(900, 1600) })).toMatch(/low confidence/i);
  });

  it('still reports the raw basis plainly when no reference was asked for', () => {
    expect(text(report(100), {})).toMatch(/raw seconds, not normalized/);
  });
});

describe('referenceFrom', () => {
  const budget = { workload: 'w1', baselineMs: 1000, factorRange: [0.8, 1.5], maxDrift: 1.2 };
  it('takes the two medians and the baseline, range and drift limit from the budget file', () => {
    expect(referenceFrom({ before: { workload: 'w1', medianMs: 900 }, after: { workload: 'w1', medianMs: 1100 }, budget }))
      .toEqual({ beforeMs: 900, afterMs: 1100, baselineMs: 1000, runner: { baseline: { cpus: undefined, platform: undefined }, before: { cpus: undefined, platform: undefined }, after: { cpus: undefined, platform: undefined } }, factorRange: [0.8, 1.5], maxDrift: 1.2 });
  });

  it('drops a measurement of a different workload than the baseline was taken with, which then reads as missing', () => {
    const r = referenceFrom({ before: { workload: 'w2', medianMs: 900 }, after: { workload: 'w1', medianMs: 1100 }, budget });
    expect(r.beforeMs).toBeUndefined();
    expect(assessReference(r).status).toBe('missing');
  });

  it('is all absent, not throwing, when a file was never written', () => {
    expect(assessReference(referenceFrom({ budget })).status).toBe('missing');
    expect(assessReference(referenceFrom({})).status).toBe('missing');
  });
});
