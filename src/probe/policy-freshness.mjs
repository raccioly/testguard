import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validate, methodOf } from '../../spec/lib/validate.mjs';
import { sha256 } from '../util/hash.mjs';
import { defenderSelection, isReusable, subjectOf } from './attribution.mjs';
import { discoverDefendersDetailed } from './discover.mjs';
import { resolveDefenders } from './runners/shared.mjs';
import { hashNativeTestUniverse } from './universe.mjs';

// Point-in-time reads, not a transaction over the whole project. Never turn a
// missing file into the empty-file hash that diagnostic probe records can use.
function currentHash(projectDir, file) {
  if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('unsafe input path');
  const path = join(projectDir, file);
  const resolved = realpathSync(path);
  const inside = relative(realpathSync(projectDir), resolved);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('input escaped project');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('input is not a regular file');
    const hash = sha256(readFileSync(fd));
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || realpathSync(path) !== resolved) throw new Error('input changed during read');
    return hash;
  } finally { closeSync(fd); }
}

/** Internal policy boundary: native listing plus current per-fault bindings.
 * Legacy/static universes and any uncertainty refuse; verdicts remain intact.
 */
export function originPolicyInputsFresh({ projectDir, claims, evidence, universe }) {
  try {
    if (!validate('claims', claims).ok || !validate('evidence', evidence).ok) return false;
    if (methodOf(evidence.run) !== 'fault-injection' || evidence.run.provisional || evidence.run.confirmRuns < 3) return false;
    const testUniverseHash = hashNativeTestUniverse(universe.manifests);
    if (universe.testUniverseHash !== testUniverseHash) return false;
    // Where the runner came from is part of its identity: a global vitest of
    // the same version is a different binary from the project's, the same
    // rule verdict reuse applies (sameRunner in probe.mjs).
    const matchesRunner = (recorded, current) => recorded?.name === current?.name && recorded?.version === current?.version
      && (recorded?.source ?? null) === (current?.source ?? null);
    if (!universe.primaryRunner || !matchesRunner(evidence.run.runner, universe.primaryRunner)) return false;
    if ((evidence.run.runners ?? []).some((recorded) => !universe.runners?.some((current) => matchesRunner(recorded, current)))) return false;
    const allTests = Object.freeze([...new Set([...universe.manifests.values()].flatMap((m) => m.files))].sort());
    const expected = new Map();
    for (const claim of claims.claims) for (const fault of claim.faults) {
      if (methodOf(fault) !== 'fault-injection') return false;
      expected.set(JSON.stringify([claim.id, fault.id]), { claim, fault });
    }
    if (!expected.size || evidence.records.length !== expected.size) return false;
    const seen = new Set();
    for (const record of evidence.records) {
      const key = JSON.stringify([record.claim.id, record.subject.id]);
      const current = expected.get(key);
      if (!current || seen.has(key)) return false;
      seen.add(key);
      const { claim, fault } = current;
      const subject = subjectOf(fault, sha256);
      if (['kind', 'id', 'file', 'faultClass', 'contentHash', 'producedBy'].some((field) => !isDeepStrictEqual(record.subject[field], subject[field]))) return false;
      const { requested, selectionSource } = defenderSelection(claim, fault);
      const discovery = requested.length ? null : discoverDefendersDetailed(projectDir, fault.file, allTests);
      if (discovery?.indeterminate.length) return false;
      const resolved = requested.length ? resolveDefenders(projectDir, requested) : discovery.canDetect;
      if (resolved.some((file) => !allTests.includes(file))) return false;
      const hashes = (files) => Object.fromEntries(files.map((file) => [file, currentHash(projectDir, file)]));
      const inputs = {
        targetHash: currentHash(projectDir, fault.file),
        defenderHashes: hashes(resolved),
        testUniverseHash,
        discoveryHashes: hashes(discovery?.dependencies ?? []),
      };
      if (!isReusable(record, { claim, requested, resolved, selectionSource, contentHash: subject.contentHash, inputs })) return false;
    }
    return true;
  } catch { return false; }
}
