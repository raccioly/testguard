// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// The pure half of calibration: no git, no fixture corpus, no scratch worktree.
// These lived in replay.test.mjs, whose scripted-corpus setup costs tens of
// seconds a run. A claim defended by a file pays for every test in that file,
// so the claims these tests kill were re-pointed here and re-probed — the #73
// pattern: move the defender, then prove the kill again, never assume it.
import { describe, it, expect } from 'vitest';
import { calibrationFrom, wilson, MEASURED_VERDICTS } from '../src/replay/replay.mjs';
import { validate } from '../spec/lib/validate.mjs';

const doc = (verdicts, faultClass = 'guard-removed') => ({
  tool: { name: 'testguard', version: 'test' },
  run: { range: 'HEAD~3..HEAD' },
  records: verdicts.map((verdict) => ({ verdict, faultClass })),
});

describe('wilson — a label carries its sample size', () => {
  it('is 0..1 with a wide interval at small n and a narrower one as n grows', () => {
    // No trials, no proportion: 0 would be a fabricated point estimate. The interval is maximal ignorance.
    expect(wilson(0, 0)).toEqual({ p: null, ci: [0, 1] });
    const small = wilson(1, 2);
    const large = wilson(50, 100);
    expect(small.p).toBe(0.5);
    expect(large.p).toBe(0.5);
    expect(small.ci[1] - small.ci[0]).toBeGreaterThan(large.ci[1] - large.ci[0]);
    for (const w of [small, large]) {
      expect(w.ci[0]).toBeLessThanOrEqual(w.p);
      expect(w.ci[1]).toBeGreaterThanOrEqual(w.p);
    }
  });
  it('never leaves the unit interval, even at the extremes', () => {
    for (const [k, n] of [[0, 1], [1, 1], [0, 3], [3, 3]]) {
      const w = wilson(k, n);
      expect(w.ci[0]).toBeGreaterThanOrEqual(0);
      expect(w.ci[1]).toBeLessThanOrEqual(1);
    }
  });
});

describe('calibrationFrom — misses over measurable, per fault class', () => {
  it('measures exactly three verdicts: caught, blind, nocover', () => {
    expect([...MEASURED_VERDICTS]).toEqual(['caught', 'blind', 'nocover']);
  });

  it('nocover is a miss and counts as one: it enters both the numerator and the denominator', () => {
    const cal = calibrationFrom(doc(['caught', 'nocover', 'blind']));
    // 2 of 3 missed. Excluding nocover would report 1 of 2; counting it only in
    // the denominator would report 1 of 3. Both err in the optimistic direction,
    // and the first rewards having no tests at all.
    expect(cal.buckets['guard-removed']).toMatchObject({ n: 3, positives: 2, breakdown: { caught: 1, blind: 1, nocover: 1 } });
  });

  it('a project with no tests for a subsystem never scores better than one with weak tests', () => {
    const weak = calibrationFrom(doc(['caught', 'caught', 'caught', 'blind', 'blind', 'blind', 'blind', 'blind', 'blind', 'blind']));
    const none = calibrationFrom(doc(['caught', 'caught', 'caught', 'nocover', 'nocover', 'nocover', 'nocover', 'nocover', 'nocover', 'nocover']));
    expect(none.buckets['guard-removed'].p).toBeGreaterThanOrEqual(weak.buckets['guard-removed'].p);
  });

  it('flaky and unverifiable are failed measurements and enter neither side', () => {
    const cal = calibrationFrom(doc(['flaky', 'unverifiable', 'blind']));
    expect(cal.buckets['guard-removed']).toMatchObject({ n: 1, positives: 1 });
  });

  it('says what it measures and where it came from, and the document conforms', () => {
    const cal = calibrationFrom(doc(['caught', 'blind']), { toolVersion: 'test' });
    expect(cal.measures).toBe('escape-missed');
    expect(cal.source).toMatchObject({ kind: 'bug-replay', ref: 'HEAD~3..HEAD' });
    expect(cal.source.caveat).toMatch(/own fix history/);
    expect(validate('calibration', cal).errors).toEqual([]);
  });
});
