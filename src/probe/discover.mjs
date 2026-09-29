import { join } from 'node:path';
import { listTestFiles } from './runners/shared.mjs';
import { testGlobs as PY_TEST_GLOBS } from './runners/python.mjs';
import { fileImportRelation } from './rank.mjs';
import { pyFileImports } from './pyimports.mjs';
import { classifyDefenders } from './mocks.mjs';
import { normalizeDiscoveredFiles } from './runners/discovery.mjs';

/** A target's language decides how its importers are found. Nothing else about it matters here. */
export const isPython = (rel) => rel.endsWith('.py');

/**
 * When a claim declares no defenders: the test files that import the fault's
 * target file — directly, by relative path or through a resolved alias in
 * JavaScript, by module name in Python — and do NOT replace it wholesale. A
 * file that mocks the target cannot detect any fault in it; counting it would
 * make `nocover` under-report and waste probe runs on files that cannot fail.
 * `nocover` therefore means exactly "no test file imports this source without
 * mocking it".
 */
const explicitFiles = (projectDir, testUniverse) => {
  if (testUniverse === undefined) return null;
  if (!Array.isArray(testUniverse) && !Object.isFrozen(testUniverse)) throw new TypeError('explicit test universe manifest must be immutable');
  const files = Array.isArray(testUniverse) ? testUniverse : testUniverse?.files;
  if (!Array.isArray(files)) throw new TypeError('explicit test universe must be an array or a manifest with files');
  if (!Object.isFrozen(files)) throw new TypeError('explicit test universe must be immutable');
  return normalizeDiscoveredFiles(projectDir, files);
};

export function discoverDefendersDetailed(projectDir, targetRel, testUniverse) {
  const explicit = explicitFiles(projectDir, testUniverse);
  const candidates = explicit ?? (isPython(targetRel) ? listTestFiles(projectDir, PY_TEST_GLOBS) : listTestFiles(projectDir));
  if (isPython(targetRel)) {
    const pythonCandidates = candidates.filter((t) => t.endsWith('.py'));
    const importing = pythonCandidates.filter((t) => pyFileImports(projectDir, join(projectDir, t), targetRel, t));
    return { importing, ...classifyDefenders(projectDir, targetRel, importing), indeterminate: [], dependencies: pythonCandidates, relations: new Map() };
  }

  const relations = new Map();
  const importing = [];
  const indeterminate = [];
  const jsCandidates = candidates.filter((candidate) => !candidate.endsWith('.py'));
  // Every candidate's source participates in the negative discovery result:
  // editing an unrelated test so it starts importing the target must invalidate
  // a prior `nocover`, not silently reuse it.
  const dependencies = new Set(jsCandidates);
  for (const file of jsCandidates) {
    const relation = fileImportRelation(projectDir, join(projectDir, file), targetRel);
    relations.set(file, relation);
    for (const dependency of relation.dependencies) dependencies.add(dependency);
    if (relation.status === 'matched') importing.push(file);
    else if (relation.status === 'indeterminate') indeterminate.push({ file, reason: relation.reason, issues: relation.issues ?? [] });
  }
  return {
    importing,
    ...classifyDefenders(projectDir, targetRel, importing, relations),
    indeterminate,
    dependencies: [...dependencies].sort(),
    relations,
  };
}

export function discoverDefenders(projectDir, targetRel, testUniverse) {
  return discoverDefendersDetailed(projectDir, targetRel, testUniverse).canDetect;
}
