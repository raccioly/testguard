import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';
const example = (kind) => JSON.parse(readFileSync(new URL(`./examples/${kind}.json`, import.meta.url), 'utf8'));
function withPolicy(kind) {
  const doc = example(kind);
  // The legacy example demonstrates multiple verdicts for the same identity;
  // an available policy requires a unique full universe instead.
  if (kind === 'evidence') doc.records.forEach((r, i) => {
    r.subject.id = `F-${i}`;
    r.fingerprint = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file, verdict: r.verdict });
  });
  if (kind === 'status') delete doc.run;
  doc.originPolicy = {
    state: 'unavailable', eligibleKinds: ['comment', 'spec'],
    claims: kind === 'evidence' ? new Set(doc.records.map((r) => r.claim.id)).size : kind === 'status' ? doc.counts.claims : doc.summary.claims,
    faults: kind === 'evidence' ? doc.records.length : kind === 'status' ? doc.counts.faults : Object.values(doc.summary.byVerdict).reduce((a, b) => a + b, 0),
    ineligibleClaims: [], nonKilledFaults: kind === 'evidence' ? doc.records.filter((r) => r.verdict !== 'killed').map((r) => ({ claimId: r.claim.id, faultId: r.subject.id })) : [],
    unavailableReasons: ['stale-inputs'],
  };
  return doc;
}
for (const kind of ['evidence', 'status', 'brief']) {
  it(`${kind} accepts legacy omission and optional closed policy without mutation`, () => {
    expect(validate(kind, example(kind)).errors).toEqual([]);
    const doc = withPolicy(kind), before = JSON.stringify(doc);
    expect(validate(kind, doc).errors).toEqual([]); expect(JSON.stringify(doc)).toBe(before);
  });
  it.each(['extra', 'unknown-kind', 'empty-kinds', 'duplicate-kind', 'unsorted-kinds', 'unknown-reason', 'fraction', 'missing', 'optimistic-state', 'empty-failure', 'empty-pass'])(`${kind} refuses policy %s`, (fault) => {
    const doc = withPolicy(kind), p = doc.originPolicy;
    if (fault === 'extra') p.ref = 'forbidden';
    if (fault === 'unknown-kind') p.eligibleKinds = ['authenticated'];
    if (fault === 'empty-kinds') p.eligibleKinds = [];
    if (fault === 'duplicate-kind') p.eligibleKinds = ['spec', 'spec'];
    if (fault === 'unsorted-kinds') p.eligibleKinds.reverse();
    if (fault === 'unknown-reason') p.unavailableReasons = ['anything'];
    if (fault === 'fraction') p.faults = 0.5;
    if (fault === 'missing') delete p.nonKilledFaults;
    if (fault === 'optimistic-state') p.state = 'passed';
    if (fault === 'empty-failure') { p.state = 'failed'; p.unavailableReasons = []; p.nonKilledFaults = []; }
    if (fault === 'empty-pass') { p.state = 'passed'; p.unavailableReasons = []; p.nonKilledFaults = []; p.claims = 0; p.faults = 0; }
    expect(validate(kind, doc).ok).toBe(false);
  });
}
it('evidence binds every non-killed identity, denominators and recorded eligibility', () => {
  const doc = withPolicy('evidence'), p = doc.originPolicy;
  p.state = 'failed'; p.unavailableReasons = [];
  expect(validate('evidence', doc).errors).toEqual([]);
  p.nonKilledFaults.pop(); expect(validate('evidence', doc).ok).toBe(false);
  p.nonKilledFaults = withPolicy('evidence').originPolicy.nonKilledFaults;
  p.eligibleKinds = ['spec']; expect(validate('evidence', doc).ok).toBe(false);
  p.ineligibleClaims = [...new Set(doc.records.filter((r) => r.claim.source.kind !== 'spec').map((r) => r.claim.id))].sort();
  expect(validate('evidence', doc).errors).toEqual([]);
  p.faults++; expect(validate('evidence', doc).ok).toBe(false);
});
it('status run codes preserve unavailable, policy failure and ordinary findings', () => {
  const doc = withPolicy('status'), p = doc.originPolicy; delete doc.originPolicy;
  doc.run = { id: 'R-1', evidence: '.testguard/evidence.json', provisional: false, records: p.faults, newSinceBaseline: 0, exitCode: 2, originPolicy: p };
  expect(validate('status', doc).errors).toEqual([]);
  doc.run.exitCode = 0; expect(validate('status', doc).ok).toBe(false);
  doc.run.exitCode = 2; delete doc.run.originPolicy; expect(validate('status', doc).ok).toBe(false);
  doc.run.originPolicy = { ...p, state: 'failed', unavailableReasons: [], ineligibleClaims: ['C-1'] };
  doc.run.exitCode = 1; expect(validate('status', doc).errors).toEqual([]);
  doc.run.exitCode = 0; expect(validate('status', doc).ok).toBe(false);
  doc.run.originPolicy = { ...p, state: 'passed', unavailableReasons: [] }; doc.run.newSinceBaseline = 1;
  doc.run.exitCode = 1; expect(validate('status', doc).errors).toEqual([]);
  doc.run.exitCode = 0; expect(validate('status', doc).ok).toBe(false);
  doc.run.newSinceBaseline = 0; expect(validate('status', doc).errors).toEqual([]);
  doc.run.provisional = true; expect(validate('status', doc).ok).toBe(false);
});
