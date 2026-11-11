// `run.budget`, `run.failureKind` and the not-reached record (issue #235).
// The generic suite only checks that each invalid document fails; this one
// pins WHY, so a validator rule cannot be dropped while a different error
// keeps the file red.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir, file) => JSON.parse(readFileSync(join(here, dir, file), 'utf8'));
const paths = (kind, doc) => validate(kind, doc).errors.map((e) => e.path);

describe('command budget evidence', () => {
  it('an exhausted run with not-reached records conforms', () => {
    const doc = load('examples', 'evidence-partial-budget.json');
    expect(doc.run.budget.exhausted).toBe(true);
    expect(doc.records.some((r) => r.detail.reason === 'not-reached-within-budget')).toBe(true);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('exhausted must agree with the presence of not-reached records', () => {
    expect(paths('evidence', load('invalid', 'evidence.budget-not-exhausted-but-records-not-reached.json'))).toContain('/run/budget/exhausted');
    const doc = load('examples', 'evidence-partial-budget.json');
    doc.records = doc.records.filter((r) => r.detail.reason !== 'not-reached-within-budget');
    doc.run.budget = { limitMs: doc.run.budget.limitMs, exhausted: true, reached: doc.records.length, notReached: 0 };
    doc.run.reuse = { reused: 0, measured: doc.records.length };
    doc.origins = undefined;
    expect(paths('evidence', doc)).toContain('/run/budget/exhausted');
  });

  it('reached and notReached are each checked against the records, and their sum against the record count', () => {
    expect(paths('evidence', load('invalid', 'evidence.budget-counts-disagree-with-records.json'))).toEqual(expect.arrayContaining(['/run/budget/notReached', '/run/budget/reached']));
    expect(paths('evidence', load('invalid', 'evidence.budget-reached-plus-not-reached-is-not-the-record-count.json'))).toContain('/run/budget');
  });

  it('a not-reached record without run.budget describes a run that does not say it was budgeted', () => {
    expect(paths('evidence', load('invalid', 'evidence.not-reached-record-without-budget.json'))).toContain('/run/budget');
  });

  it('a not-reached record is unverifiable, has no runs and is never reused', () => {
    expect(paths('evidence', load('invalid', 'evidence.not-reached-record-with-runs.json'))).toContain('/records/2/detail');
    expect(paths('evidence', load('invalid', 'evidence.not-reached-record-with-a-verdict.json'))).toContain('/records/2/verdict');
    expect(paths('evidence', load('invalid', 'evidence.not-reached-record-reused.json'))).toContain('/records/2/reusedFrom');
  });

  it('an origin policy cannot certify an exhausted run', () => {
    const doc = load('examples', 'evidence-partial-budget.json');
    doc.originPolicy = { state: 'unavailable', eligibleKinds: ['manual'], claims: 0, faults: 0, ineligibleClaims: [], nonKilledFaults: [], unavailableReasons: ['provisional-evidence'] };
    expect(paths('evidence', doc)).toContain('/originPolicy');
  });
});

describe('command budget status', () => {
  it('an exhausted run with a gating finding in its measured part conforms and names the floor', () => {
    const doc = load('examples', 'status-partial-budget.json');
    expect(doc.run.failureKind).toBe('unproven+incomplete');
    expect(doc.run.unprovenAtLeast).toBeGreaterThanOrEqual(1);
    expect(validate('status', doc).errors).toEqual([]);
  });

  it('an exhausted budget never exits 0 and always carries a failure kind', () => {
    expect(paths('status', load('invalid', 'status.exhausted-budget-exits-zero.json'))).toContain('/run/exitCode');
    expect(paths('status', load('invalid', 'status.exhausted-budget-without-failure-kind.json'))).toContain('/run/failureKind');
  });

  it('the failure kind decides the exit code, and the floor belongs to unproven+incomplete only', () => {
    expect(paths('status', load('invalid', 'status.unproven-incomplete-without-a-floor.json'))).toContain('/run/unprovenAtLeast');
    expect(paths('status', load('invalid', 'status.incomplete-with-a-floor.json'))).toContain('/run/unprovenAtLeast');
    expect(paths('status', load('invalid', 'status.incomplete-exits-one.json'))).toContain('/run/failureKind');
  });

  it('exit 2 with nothing gating so far is `incomplete`', () => {
    const doc = load('examples', 'status-partial-budget.json');
    doc.run.failureKind = 'incomplete';
    doc.run.exitCode = 2;
    delete doc.run.unprovenAtLeast;
    doc.run.newSinceBaseline = 0;
    expect(validate('status', doc).errors).toEqual([]);
  });
});
