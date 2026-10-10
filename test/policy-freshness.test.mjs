import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { originPolicyInputsFresh } from '../src/probe/policy-freshness.mjs';
import { createDiscoveryManifest } from '../src/probe/runners/discovery.mjs';
import { hashNativeTestUniverse } from '../src/probe/universe.mjs';
import { discoverDefendersDetailed } from '../src/probe/discover.mjs';
import { subjectOf } from '../src/probe/attribution.mjs';
import { hashFile, sha256 } from '../src/util/hash.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';

const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// Conforming synthetic receipts exercise binding, not independent observations.
function fixture(discovered = false) {
  const projectDir = mkdtempSync(join(tmpdir(), 'tg-policy-binding-')); dirs.push(projectDir);
  mkdirSync(join(projectDir, 'src')); mkdirSync(join(projectDir, 'test'));
  writeFileSync(join(projectDir, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(projectDir, 'src/index.mjs'), "export { value } from './value.mjs';\n");
  writeFileSync(join(projectDir, 'test/value.test.mjs'), "import { value } from '../src/index.mjs';\n");
  writeFileSync(join(projectDir, 'test/negative.test.mjs'), 'export const unrelated = true;\n');
  const record = structuredClone(example.records.find((r) => r.verdict === 'killed'));
  const fault = { id: record.subject.id, description: 'Change value.', file: 'src/value.mjs', faultClass: record.subject.faultClass, find: 'value = 1', replace: 'value = 2', producedBy: { producer: 'human' } };
  record.subject = subjectOf(fault, sha256);
  record.fingerprint = fingerprint({ claimId: record.claim.id, subjectId: fault.id, file: fault.file, verdict: record.verdict });
  const claim = { ...record.claim, faults: [fault], ...(discovered ? {} : { defendedBy: ['test/value.test.mjs'] }) };
  const files = ['test/negative.test.mjs', 'test/value.test.mjs'];
  const manifests = new Map([[{ name: 'vitest' }, createDiscoveryManifest({ runner: 'vitest', version: '5.0.1', files })]]);
  const primaryRunner = { name: 'vitest', version: '5.0.1', source: example.run.runner.source };
  const universe = { manifests, primaryRunner, runners: [primaryRunner], testUniverseHash: hashNativeTestUniverse(manifests) };
  const discovery = discovered ? discoverDefendersDetailed(projectDir, fault.file, Object.freeze(files)) : null;
  const resolved = discovered ? discovery.canDetect : claim.defendedBy;
  record.defenders = { requested: discovered ? [] : claim.defendedBy, resolved, discovered, nocover: resolved.length === 0, selectionSource: discovered ? 'discovery' : 'claim' };
  record.inputs = {
    targetHash: hashFile(join(projectDir, fault.file)),
    defenderHashes: Object.fromEntries(resolved.map((file) => [file, hashFile(join(projectDir, file))])),
    testUniverseHash: universe.testUniverseHash,
    discoveryHashes: Object.fromEntries((discovery?.dependencies ?? []).map((file) => [file, hashFile(join(projectDir, file))])),
  };
  const claims = { schemaVersion: 1, claims: [claim] };
  const evidence = { ...structuredClone(example), records: [record] };
  delete evidence.run.runners;
  expect(validate('claims', claims).errors).toEqual([]);
  const errors = validate('evidence', evidence).errors;
  expect(errors, JSON.stringify(errors)).toEqual([]);
  return { projectDir, claims, evidence, universe };
}

it.each([false, true])('admits complete unchanged %s bindings without rewriting evidence', (discovered) => {
  const input = fixture(discovered); const before = JSON.stringify(input.evidence);
  expect(originPolicyInputsFresh(input)).toBe(true);
  expect(JSON.stringify(input.evidence)).toBe(before);
});
it.each(['src/value.mjs', 'test/value.test.mjs'])('refuses changed or absent input %s', (file) => {
  const input = fixture(); writeFileSync(join(input.projectDir, file), 'changed\n');
  expect(originPolicyInputsFresh(input)).toBe(false);
  rmSync(join(input.projectDir, file)); expect(originPolicyInputsFresh(input)).toBe(false);
});
it.each(['src/index.mjs', 'test/negative.test.mjs'])('recomputes current discovery dependencies including %s', (file) => {
  const input = fixture(true); writeFileSync(join(input.projectDir, file), '// changed\n');
  expect(originPolicyInputsFresh(input)).toBe(false);
});
it('refuses a changed discovery set even when the defender and target bytes are unchanged', () => {
  const input = fixture(true);
  delete input.evidence.records[0].inputs.discoveryHashes['src/index.mjs'];
  expect(originPolicyInputsFresh(input)).toBe(false);
});
it.each(['testUniverseHash', 'discoveryHashes'])('refuses absent legacy binding %s', (field) => {
  const input = fixture(); delete input.evidence.records[0].inputs[field];
  expect(originPolicyInputsFresh(input)).toBe(false);
});
it('refuses updated universe membership/configuration and self-inconsistent manifests', () => {
  const input = fixture(); const [runner] = input.universe.manifests.keys();
  for (const change of [{ files: ['test/value.test.mjs'] }, { configFiles: [{ path: 'vitest.config.mjs', sha256: 'a'.repeat(64) }] }, { version: '6.0' }]) {
    const manifests = new Map([[runner, createDiscoveryManifest({ runner: runner.name, version: '5.0.1', files: ['test/negative.test.mjs', 'test/value.test.mjs'], ...change })]]);
    expect(originPolicyInputsFresh({ ...input, universe: { ...input.universe, manifests, testUniverseHash: hashNativeTestUniverse(manifests) } })).toBe(false);
  }
  input.universe.testUniverseHash = 'a'.repeat(64); expect(originPolicyInputsFresh(input)).toBe(false);
});
it('refuses escaping symlink parents even with identical file bytes', () => {
  const input = fixture(); const outside = mkdtempSync(join(tmpdir(), 'tg-policy-outside-')); dirs.push(outside);
  writeFileSync(join(outside, 'value.mjs'), readFileSync(join(input.projectDir, 'src/value.mjs')));
  rmSync(join(input.projectDir, 'src'), { recursive: true }); symlinkSync(outside, join(input.projectDir, 'src'), 'dir');
  expect(originPolicyInputsFresh(input)).toBe(false);
});
it('refuses incomplete/duplicate universes and current metadata/fault changes', () => {
  for (const change of [
    (x) => { x.evidence.records = []; },
    (x) => { x.evidence.records.push(structuredClone(x.evidence.records[0])); },
    (x) => { x.claims.claims[0].source = { kind: 'bug' }; },
    (x) => { x.claims.claims[0].faults[0].replace = 'value = 3'; },
    (x) => { x.claims.claims[0].defendedBy = ['test/negative.test.mjs']; },
    (x) => { x.evidence.run.method = 'scan'; },
  ]) { const input = fixture(); change(input); expect(originPolicyInputsFresh(input)).toBe(false); }
});
it('does not treat missing input as empty content or rewrite measured verdicts', () => {
  const input = fixture(); const record = input.evidence.records[0];
  record.inputs.targetHash = sha256(''); rmSync(join(input.projectDir, 'src/value.mjs'));
  expect(originPolicyInputsFresh(input)).toBe(false);
  expect(record.verdict).toBe('killed');
});
it('refuses changed or missing runner identities including an owning engine', () => {
  for (const change of [
    (x) => { delete x.universe.primaryRunner; },
    (x) => { x.universe.primaryRunner.name = 'jest'; },
    (x) => { x.universe.primaryRunner.version = '6.0'; },
    (x) => { x.evidence.run.runners = [{ name: 'pytest', version: '8.0' }]; },
    (x) => { x.universe.primaryRunner.source = 'path'; },
    (x) => { x.evidence.run.runner.source = 'project'; x.universe.primaryRunner.source = 'path'; },
  ]) { const input = fixture(); change(input); expect(originPolicyInputsFresh(input)).toBe(false); }
});
