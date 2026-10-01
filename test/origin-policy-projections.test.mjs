import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBrief, renderBriefMarkdown } from '../src/brief/brief.mjs';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { evaluateOriginPolicy } from '../src/probe/origin-policy.mjs';
import { subjectOf } from '../src/probe/attribution.mjs';
import { hashFile, sha256 } from '../src/util/hash.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';

const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
// Synthetic schema-valid receipts, not independent empirical measurements.
function receipt(state) {
  const record = structuredClone(example.records.find((r) => r.verdict === (state === 'failed' ? 'survived' : 'killed')));
  const fault = { id: record.subject.id, file: record.subject.file, description: 'Change value.', faultClass: record.subject.faultClass, find: 'value = 1', replace: 'value = 2', producedBy: { producer: 'agent' } };
  record.subject = subjectOf(fault, sha256);
  const claims = { schemaVersion: 1, claims: [{ ...structuredClone(record.claim), defendedBy: record.defenders.requested, faults: [fault] }] };
  const evidence = { ...structuredClone(example), records: [record] };
  evidence.originPolicy = evaluateOriginPolicy({ claims, evidence, eligibleKinds: ['spec'], fresh: state !== 'unavailable' });
  expect(evidence.originPolicy.state).toBe(state);
  expect(validate('evidence', evidence).errors).toEqual([]);
  return { claims, evidence };
}
it.each(['passed', 'failed', 'unavailable'])('brief preserves recorded %s policy before max=0 and baseline filtering', (state) => {
  const { evidence } = receipt(state); const before = JSON.stringify(evidence);
  const baseline = { fingerprints: Object.fromEntries(evidence.records.map((r) => [r.fingerprint, 1])) };
  const brief = buildBrief(evidence, baseline, { max: 0 });
  expect(brief.items).toEqual([]);
  expect(brief.originPolicy).toEqual(evidence.originPolicy);
  expect(validate('brief', brief).errors).toEqual([]);
  for (const text of [brief.text, renderBriefMarkdown(brief, { hasBaseline: true, total: evidence.records.length })]) {
    expect(text).toContain(`origin policy (recorded run): ${state}`);
    expect(text).toContain('not current freshness');
    expect(text).toContain('not authenticated independence');
    expect(text).not.toContain(evidence.records[0].claim.source.ref);
    if (state === 'failed') { expect(text).not.toContain('Every probed claim is defended'); expect(text).toContain('1 unproven faults remain'); }
  }
  brief.originPolicy.eligibleKinds.push('bug');
  expect(JSON.stringify(evidence)).toBe(before);
});
it('a capped legacy brief also cannot claim survivors are defended', () => {
  const { evidence } = receipt('failed'); delete evidence.originPolicy;
  const brief = buildBrief(evidence, undefined, { max: 0 });
  expect(brief).not.toHaveProperty('originPolicy');
  expect(brief.text).not.toContain('Every probed claim is defended');
  expect(renderBriefMarkdown(brief, { total: 1 })).not.toContain('Every probed claim is defended');
});
it('offline status recomputes current declarations but never promotes recorded pass to current freshness', () => {
  const { claims, evidence } = receipt('passed');
  const dir = mkdtempSync(join(tmpdir(), 'tg-offline-policy-'));
  try {
    for (const file of [claims.claims[0].faults[0].file, ...evidence.records[0].defenders.resolved]) {
      mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), 'export const value = 1;\n');
    }
    evidence.records[0].inputs.targetHash = hashFile(join(dir, claims.claims[0].faults[0].file));
    for (const file of evidence.records[0].defenders.resolved) evidence.records[0].inputs.defenderHashes[file] = hashFile(join(dir, file));
    writeSpecDoc('claims', join(dir, 'testguard.claims.json'), claims);
    writeSpecDoc('evidence', join(dir, '.testguard/evidence.json'), evidence);
    const status = computeStatus({ projectDir: dir });
    expect(status.originPolicy).toMatchObject({ state: 'unavailable', unavailableReasons: ['stale-inputs'], nonKilledFaults: [] });
    expect(validate('status', status).errors).toEqual([]);
    expect(renderStatus(status)).toContain('origin policy (current declarations; offline freshness unavailable): unavailable');
    claims.claims[0].source = { kind: 'bug', ref: 'opaque-do-not-echo' };
    writeSpecDoc('claims', join(dir, 'testguard.claims.json'), claims);
    const changed = computeStatus({ projectDir: dir });
    expect(changed.originPolicy).toMatchObject({ state: 'unavailable', ineligibleClaims: [claims.claims[0].id] });
    expect(changed.originPolicy.unavailableReasons).toContain('claim-metadata-mismatch');
    expect(renderStatus(changed)).not.toContain('opaque-do-not-echo');
    expect(validate('status', changed).errors).toEqual([]);
    const withoutPolicy = structuredClone(evidence); delete withoutPolicy.originPolicy;
    writeSpecDoc('evidence', join(dir, '.testguard/evidence.json'), withoutPolicy);
    const legacy = computeStatus({ projectDir: dir });
    expect(legacy).not.toHaveProperty('originPolicy');
    expect(changed.state).toBe(legacy.state); expect(changed.next).toEqual(legacy.next);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
