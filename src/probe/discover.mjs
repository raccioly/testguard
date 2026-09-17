import { join } from 'node:path';
import { listTestFiles } from './runners/shared.mjs';
import { fileImports } from './rank.mjs';
import { classifyDefenders } from './mocks.mjs';

/**
 * When a claim declares no defenders: the test files that import the fault's
 * target file — directly, by relative path or through a resolved alias — and
 * do NOT mock it. A file that mocks the target cannot detect any fault in it;
 * counting it would make `nocover` under-report and waste probe runs on files
 * that cannot fail. `nocover` therefore means exactly "no test file imports
 * this source without mocking it".
 */
export function discoverDefendersDetailed(projectDir, targetRel) {
  const importing = listTestFiles(projectDir).filter((t) => fileImports(projectDir, join(projectDir, t), targetRel));
  return { importing, ...classifyDefenders(projectDir, targetRel, importing) };
}

export function discoverDefenders(projectDir, targetRel) {
  return discoverDefendersDetailed(projectDir, targetRel).canDetect;
}
