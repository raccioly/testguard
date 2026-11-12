// Convergence (#293): a scoped run that updated the canonical evidence. The
// generic suite only checks that each invalid document fails; this one pins WHY.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir, file) => JSON.parse(readFileSync(join(here, dir, file), 'utf8'));
const paths = (file) => validate('evidence', load('invalid', file)).errors.map((e) => e.path);

describe('converged evidence', () => {
  it('a document with measured, carried and kept-stale records conforms', () => {
    const doc = load('examples', 'evidence-converged.json');
    expect(doc.records.map((r) => r.carried ?? 'measured')).toEqual(['measured', 'measured', 'inputs-changed', 'inputs-changed', 'inputs-match', 'inputs-match']);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('a carried record names the run that measured it', () => {
    expect(paths('evidence.carried-without-reused-from.json')).toContain('/records/4/reusedFrom');
  });

  it('a selected claim is measured, never carried', () => {
    expect(paths('evidence.carried-record-of-a-selected-claim.json')).toContain('/records/0/carried');
  });

  it('a provisional run never converges', () => {
    expect(paths('evidence.converged-provisional.json')).toContain('/run/scope');
  });

  it('carried records need the scope that converged them, and counts that agree', () => {
    expect(paths('evidence.carried-without-scope.json')).toContain('/run/scope');
    expect(paths('evidence.carried-counts-disagree.json')).toContain('/run/reuse');
  });
});
