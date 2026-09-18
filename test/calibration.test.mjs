// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// The pure half of calibration: no git, no fixture corpus, no scratch worktree.
// These lived in replay.test.mjs, whose scripted-corpus setup costs tens of
// seconds a run. A claim defended by a file pays for every test in that file,
// so the claims these tests kill were re-pointed here and re-probed — the #73
// pattern: move the defender, then prove the kill again, never assume it.
import { describe, it, expect } from 'vitest';
import { calibrationFrom, wilson, MEASURED_VERDICTS, renderReplay, selectCorpus, commitType } from '../src/replay/replay.mjs';
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

describe('the calibration counts escaped bugs, not every commit that touched a test', () => {
  // A field report measured "12 of 12 measurable bugs invisible — 100%" over a
  // corpus of which five were `feat:`, one `refactor:`, one `style:` and one a
  // commit whose entire purpose was adding a test. Only four were `fix:`.
  // Reverting a feature and finding the suite silent is not the same finding
  // as reverting a bug fix and finding it silent, and `p` is defined as
  // P(the suite misses it | a BUG of this class escapes).
  //
  // Selection stays broad: the pairing rule is all that can be judged without
  // reading a subject, and replaying a feature still measures something. What
  // narrows is the corpus `p` is computed over.
  const rec = (subject, verdict, faultClass = 'guard-removed') => ({ commit: 'a'.repeat(40), subject, verdict, faultClass, ranTests: 3 });
  const doc = (records) => ({ schemaVersion: 1, tool: { name: 'testguard', version: 't' }, run: { id: 'r', startedAt: '2026-09-18T00:00:00Z', finishedAt: '2026-09-18T00:00:00Z', range: 'HEAD~60..HEAD', runner: { name: 'vitest' }, confirmRuns: 3, candidates: records.length, duplicates: 0 }, records });

  const fieldReport = doc([
    rec('fix(dashboard): show an upstream failure instead of an empty archive', 'blind'),
    rec('fix(audio): read the signed URL from the shape Pocket returns', 'blind'),
    rec('fix(auth): reject a forged admin cookie', 'nocover'),
    rec('fix(trial): skip Stripe-held trials', 'caught'),
    rec('feat(campaign): email campaign', 'blind'),
    rec('feat(onboarding): nudge cap', 'blind'),
    rec('refactor(core): extract selection', 'blind'),
    rec('test(archive): add coverage', 'blind'),
  ]);

  it('reads a conventional-commits type off a subject', () => {
    expect(commitType('fix(audio): x')).toBe('fix');
    expect(commitType('feat!: x')).toBe('feat');
    expect(commitType('revert: x')).toBe('revert');
    expect(commitType('Fix the archive bug')).toBe(null);
  });

  it('computes p over the fix: commits only, and records that it did', () => {
    const { rule, corpus } = selectCorpus(fieldReport.records);
    expect(rule).toBe('conventional-fix');
    expect(corpus).toHaveLength(4);
    const cal = calibrationFrom(fieldReport, { toolVersion: 'test' });
    const n = Object.values(cal.buckets).reduce((a, b) => a + b.n, 0);
    const positives = Object.values(cal.buckets).reduce((a, b) => a + b.positives, 0);
    expect(n).toBe(4);        // not 8
    expect(positives).toBe(3); // the caught fix: is not a miss
    expect(cal.source.detail).toMatchObject({ candidateRule: 'conventional-fix', replayed: 8, selected: 4 });
    expect(cal.source.detail.byType).toMatchObject({ fix: 4, feat: 2, refactor: 1, test: 1 });
    expect(validate('calibration', cal).errors).toEqual([]);
  });

  it('states both rates so the narrowing can be checked, and calls only the fixes escaped bugs', () => {
    const text = renderReplay(fieldReport);
    expect(text).toContain('3 of 4 escaped bugs were invisible to the suite');
    expect(text).toContain('the 4 fix:/revert: commits of 8 measurable');
    expect(text).toMatch(/over all 8 .* it is 7 of 8, 88%/);
    expect(text).not.toMatch(/\d+ fix commits replayed/); // not every replayed commit is a fix
  });

  it('a conventional repository with no fix: in range calibrates nothing rather than counting features', () => {
    // The failure mode this exists to prevent is the silent one: falling back
    // to "source and a test together" here would count two features as bugs.
    const none = doc([rec('feat(a): x', 'blind'), rec('feat(b): y', 'blind'), rec('chore(c): z', 'caught')]);
    const cal = calibrationFrom(none, { toolVersion: 'test' });
    expect(Object.keys(cal.buckets)).toEqual([]);
    expect(cal.source.detail).toMatchObject({ candidateRule: 'conventional-fix', selected: 0, replayed: 3 });
    expect(renderReplay(none)).toContain('No fix:/revert: commits among the 3 replayed');
    expect(renderReplay(none)).toContain('Widen the range');
  });

  it('falls back to every replayed commit when the project does not label them, and says so', () => {
    const plain = doc([rec('Fix the archive bug', 'blind'), rec('Add campaign emails', 'blind'), rec('Tidy up', 'caught')]);
    const cal = calibrationFrom(plain, { toolVersion: 'test' });
    expect(cal.source.detail.candidateRule).toBe('source-and-test');
    expect(Object.values(cal.buckets).reduce((a, b) => a + b.n, 0)).toBe(3);
    const text = renderReplay(plain);
    expect(text).toContain('measurable bugs were invisible'); // not "escaped bugs": we cannot tell
    expect(text).toContain('not conventional-commits');
  });

  it('never lets two calibrations be compared without saying which rule produced them', () => {
    // The finding one level up: the document must distinguish its populations.
    const a = calibrationFrom(fieldReport, { toolVersion: 'test' });
    const b = calibrationFrom(doc([rec('Fix it', 'blind'), rec('Add it', 'caught')]), { toolVersion: 'test' });
    expect(a.measures).toBe(b.measures);       // same shape, same semantics field
    expect(a.source.detail.candidateRule).not.toBe(b.source.detail.candidateRule);
    expect(a.source.caveat).not.toBe(b.source.caveat);
  });
});
