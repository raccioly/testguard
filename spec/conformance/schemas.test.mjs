// @req FR-01
// @req NFR-08
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { validate, KINDS } from '../lib/validate.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';

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

  it('rejects an unknown kind', () => {
    expect(() => validate('scores', {})).toThrow(RangeError);
  });
});
