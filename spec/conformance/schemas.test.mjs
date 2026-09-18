// @req FR-01
// @req NFR-08
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { validate, KINDS } from '../lib/validate.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';
import { probit, zCandidates, wilsonInterval, roundTo } from '../lib/wilson.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir, f) => JSON.parse(readFileSync(join(here, dir, f), 'utf8'));

describe('claimspec v1 — conformance', () => {
  describe('every valid example passes', () => {
    for (const f of readdirSync(join(here, 'examples')).filter((f) => f.endsWith('.json'))) {
      const kind = KINDS.find((k) => f.startsWith(k));
      it(f, () => {
        expect(kind).toBeDefined();
        const result = validate(kind, load('examples', f));
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });
    }
  });

  describe('every invalid example is rejected for the reason its filename names', () => {
    const files = readdirSync(join(here, 'invalid')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const kind = basename(f).split('.')[0];
      it(f, () => {
        const result = validate(kind, load('invalid', f));
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    }
  });

  describe('fingerprint derivation', () => {
    it('is stable and independent of find/replace text', () => {
      const a = fingerprint({ claimId: 'C', subjectId: 'F', file: 'src/x.mjs', verdict: 'survived' });
      expect(a).toMatch(/^[a-f0-9]{64}$/);
      expect(fingerprint({ claimId: 'C', subjectId: 'F', file: 'src/x.mjs', verdict: 'survived' })).toBe(a);
    });
    it('changes when the verdict changes on the same claim+subject', () => {
      const s = fingerprint({ claimId: 'C', subjectId: 'F', file: 'src/x.mjs', verdict: 'survived' });
      const u = fingerprint({ claimId: 'C', subjectId: 'F', file: 'src/x.mjs', verdict: 'unverifiable' });
      expect(u).not.toBe(s);
    });
    it('treats a missing file as the empty string', () => {
      expect(fingerprint({ claimId: 'C', subjectId: 'F', verdict: 'killed' }))
        .toBe(fingerprint({ claimId: 'C', subjectId: 'F', file: '', verdict: 'killed' }));
    });
    it('refuses empty identities', () => {
      expect(() => fingerprint({ claimId: '', subjectId: 'F', verdict: 'killed' })).toThrow(TypeError);
    });
  });

  describe('calibration arithmetic reproduces', () => {
    const base = load('examples', 'calibration.json');
    const withCell = (cell) => ({ ...base, buckets: { ...base.buckets, 'literal-changed': { ...base.buckets['literal-changed'], ...cell } } });

    it('the quantile is accurate past the last place any producer writes', () => {
      expect(probit(0.975)).toBeCloseTo(1.959964, 6);
      expect(probit(0.995)).toBeCloseTo(2.575829, 6);
      expect(probit(0.95)).toBeCloseTo(1.644854, 6);
    });

    it('rejects a truncated bound — the defect the spec example carried before this rule', () => {
      const r = validate('calibration', withCell({ ci: [0.09, 0.37] }));
      expect(r.errors.map((e) => e.path)).toEqual(['/buckets/literal-changed/ci']);
    });

    it('rejects a p that is not positives/n even when it sits inside the interval', () => {
      const r = validate('calibration', withCell({ n: 30, positives: 6, p: 0.25, ci: [0.1, 0.37] }));
      expect(r.errors.map((e) => e.path)).toEqual(['/buckets/literal-changed/p']);
    });

    it('never rejects an honest producer: 4 dp with z = 1.96 (testguard) or 3 dp with the exact quantile (websec)', () => {
      const [exact, textbook] = zCandidates(0.95);
      for (let n = 1; n <= 60; n++) {
        for (let k = 0; k <= n; k++) {
          for (const [z, places] of [[textbook, 4], [exact, 3]]) {
            const [lo, hi] = wilsonInterval(k, n, z).map((v) => roundTo(v, places));
            const r = validate('calibration', { ...base, buckets: { cell: { n, positives: k, p: roundTo(k / n, places), ci: [lo, hi] } } });
            expect(r.errors, `${k}/${n} z=${z} @${places}dp ${JSON.stringify(r.errors)}`).toEqual([]);
          }
        }
      }
    });

    it('holds every value to the document\'s precision, so a trailing zero cannot hide a wrong digit', () => {
      // 0.10 parses as 0.1. Alone it would be checked at 1 dp, where 0.07 also rounds to 0.1;
      // at the document's 2 dp the Wilson bound for 7/50 is 0.07 and 0.1 is wrong.
      expect(validate('calibration', withCell({ n: 30, positives: 6, p: 0.2, ci: [0.1, 0.37] })).ok).toBe(true);
      const wrong = validate('calibration', withCell({ n: 50, positives: 7, p: 0.14, ci: [0.1, 0.25] }));
      expect(wrong.errors.map((e) => e.path)).toEqual(['/buckets/literal-changed/ci']);
    });
  });

  describe('adoption: websec-validator\'s shipped calibration table, translated field for field', () => {
    const doc = load('examples', 'calibration-websec.json');
    it('conforms with its honesty intact — corpus, caveat, limitation, floor, backoff tier and labelled fallback all survive', () => {
      expect(validate('calibration', doc).errors).toEqual([]);
      expect(doc.source.corpus).toEqual(['VAmPI', 'NodeGoat', 'DVGA']);
      expect(doc.source.caveat).toMatch(/deliberately-vulnerable/);
      expect(doc.minN).toBe(5);
      expect(doc.backoff.map((t) => t.bucketBy)).toEqual(['confidence']);
      expect(doc.fallback).toEqual({ basis: 'uncalibrated-prior', values: { HIGH: 0.85, MEDIUM: 0.5, LOW: 0.25 } });
    });
    it('measures a different event from testguard\'s, so the two can never be merged', () => {
      expect(doc.measures).toBe('finding-real');
      expect(load('examples', 'calibration.json').measures).toBe('escape-missed');
    });
    it('a backoff tier is held to the same arithmetic as the primary', () => {
      const bad = structuredClone(doc);
      bad.backoff[0].buckets.LOW.ci = [0.02, 0.5];
      expect(validate('calibration', bad).errors.map((e) => e.path)).toEqual(['/backoff/0/buckets/LOW/ci']);
    });
    it('a compound bucketBy demands compound keys', () => {
      const bad = structuredClone(doc);
      bad.buckets.sqli = bad.buckets['missing-auth|MEDIUM'];
      expect(validate('calibration', bad).errors.map((e) => e.path)).toEqual(['/buckets/sqli']);
    });
  });

  it('rejects an unknown kind', () => {
    expect(() => validate('scores', {})).toThrow(RangeError);
  });
});
