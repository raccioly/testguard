import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateOriginPolicy } from '../src/probe/origin-policy.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { subjectOf } from '../src/probe/attribution.mjs';
import { sha256 } from '../src/util/hash.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';

const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
// Synthetic regression inputs, not empirical observations.
function fixture() {
  const record = structuredClone(example.records.find((r) => r.verdict === 'killed'));
  const fault = { id: record.subject.id, description: 'Value changes.', file: record.subject.file, faultClass: record.subject.faultClass, find: 'value = 1', replace: 'value = 2', producedBy: { producer: 'human' } };
  record.subject = subjectOf(fault, sha256);
  const claims = { schemaVersion: 1, claims: [{ ...structuredClone(record.claim), faults: [fault] }] };
  const evidence = { ...structuredClone(example), records: [record] };
  expect(validate('claims', claims).errors).toEqual([]);
  expect(validate('evidence', evidence).errors).toEqual([]);
  return { claims, evidence, eligibleKinds: ['spec'], fresh: true };
}
it('is absent unless explicitly selected; normalizes an explicit set without mutating inputs', () => {
  expect(evaluateOriginPolicy({})).toBeUndefined();
  const input = fixture(); input.eligibleKinds = ['spec', 'bug', 'spec'];
  const before = JSON.stringify(input);
  expect(evaluateOriginPolicy(input)).toEqual({ state: 'passed', eligibleKinds: ['bug', 'spec'], claims: 1, faults: 1, ineligibleClaims: [], nonKilledFaults: [], unavailableReasons: [] });
  expect(JSON.stringify(input)).toBe(before);
});
it.each([[], ['unknown'], [''], 'spec', null])('refuses malformed explicit selection %j', (eligibleKinds) => {
  expect(() => evaluateOriginPolicy({ ...fixture(), eligibleKinds })).toThrow(TypeError);
});
it('fails an ineligible declaration without printing its opaque reference', () => {
  const input = fixture(); input.eligibleKinds = ['incident'];
  const result = evaluateOriginPolicy(input);
  expect(result.state).toBe('failed'); expect(result.ineligibleClaims).toEqual([input.claims.claims[0].id]);
  expect(JSON.stringify(result)).not.toContain(input.claims.claims[0].source.ref);
});
it.each([undefined, false, 'true', 1])('requires trusted literal freshness %j', (fresh) => {
  expect(evaluateOriginPolicy({ ...fixture(), fresh })).toMatchObject({ state: 'unavailable', unavailableReasons: ['stale-inputs'] });
});
it.each(['statement', 'severity', 'source', 'producedBy'])('binds current claim metadata %s', (field) => {
  const input = fixture();
  input.claims.claims[0][field] = { statement: 'Another guarantee.', severity: 'low', source: { kind: 'spec', ref: 'changed' }, producedBy: { producer: 'agent' } }[field];
  expect(evaluateOriginPolicy(input)).toMatchObject({ state: 'unavailable', unavailableReasons: ['claim-metadata-mismatch'] });
});
it('requires a complete unique universe, not matching array lengths', () => {
  const missing = fixture(); missing.evidence.records = [];
  expect(evaluateOriginPolicy(missing).unavailableReasons).toContain('missing-record');
  const duplicate = fixture(); duplicate.evidence.records.push(structuredClone(duplicate.evidence.records[0]));
  expect(evaluateOriginPolicy(duplicate).unavailableReasons).toContain('duplicate-record');
  const extra = fixture(); const r = extra.evidence.records[0]; r.subject.id = 'EXTRA';
  r.fingerprint = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file, verdict: r.verdict });
  expect(evaluateOriginPolicy(extra)).toMatchObject({ state: 'unavailable', unavailableReasons: ['extra-record', 'missing-record'] });
});
it('refuses a same-length duplicate replacing another declared fault', () => {
  const input = fixture();
  input.claims.claims[0].faults.push({ ...input.claims.claims[0].faults[0], id: 'F3' });
  input.evidence.records.push(structuredClone(input.evidence.records[0]));
  expect(evaluateOriginPolicy(input)).toMatchObject({ state: 'unavailable', faults: 2, unavailableReasons: ['duplicate-record', 'missing-record'] });
});
it('refuses reserved unmeasured methods despite a conforming killed label', () => {
  const input = fixture(); input.evidence.run.method = 'scan';
  delete input.evidence.run.confirmRuns; delete input.evidence.run.mode;
  for (const r of input.evidence.records) { delete r.defenders; delete r.inputs; r.detail = { methodDetail: { rule: 'synthetic regression fixture' } }; }
  expect(validate('evidence', input.evidence).errors).toEqual([]);
  expect(evaluateOriginPolicy(input).unavailableReasons).toContain('incompatible-method');
  const declared = fixture(); const f = declared.claims.claims[0].faults[0];
  f.method = 'scan'; delete f.find; delete f.replace;
  expect(validate('claims', declared.claims).errors).toEqual([]);
  expect(evaluateOriginPolicy(declared).unavailableReasons).toContain('incompatible-method');
});
it.each(['replace', 'file', 'producedBy'])('binds the current fault %s', (field) => {
  const input = fixture(); input.claims.claims[0].faults[0][field] = { replace: 'value = 3', file: 'src/other.mjs', producedBy: { producer: 'agent' } }[field];
  expect(evaluateOriginPolicy(input).unavailableReasons).toContain('fault-mismatch');
});
it('refuses provisional evidence even when all one-run assertions fail', () => {
  const input = fixture(); input.evidence.run.confirmRuns = 1; input.evidence.run.provisional = true;
  for (const r of input.evidence.records) { r.detail.baselineRuns.length = 1; r.detail.probeRuns.length = 1; }
  expect(validate('evidence', input.evidence).errors).toEqual([]);
  expect(evaluateOriginPolicy(input)).toMatchObject({ state: 'unavailable', unavailableReasons: ['provisional-evidence'] });
});
it('never lets eligibility, baseline debt or a severity floor excuse a survivor; unavailable dominates', () => {
  const input = fixture(); const r = input.evidence.records[0]; r.verdict = 'survived';
  r.detail.probeRuns = structuredClone(r.detail.baselineRuns);
  r.fingerprint = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file, verdict: r.verdict });
  input.baseline = { fingerprints: { [r.fingerprint]: 1 } }; input.severityFloor = 'critical';
  expect(validate('evidence', input.evidence).errors).toEqual([]);
  const result = evaluateOriginPolicy(input);
  expect(result.state).toBe('failed'); expect(result.nonKilledFaults).toEqual([{ claimId: r.claim.id, faultId: r.subject.id }]);
  input.fresh = false;
  expect(evaluateOriginPolicy(input)).toMatchObject({ state: 'unavailable', nonKilledFaults: result.nonKilledFaults });
});
it('refuses malformed documents and empty universes instead of vacuous success', () => {
  expect(evaluateOriginPolicy({ ...fixture(), claims: null, evidence: null }).state).toBe('unavailable');
  expect(evaluateOriginPolicy({ ...fixture(), claims: { schemaVersion: 1, claims: [] } }).unavailableReasons).toContain('empty-universe');
});
