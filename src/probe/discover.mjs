import { join } from 'node:path';
import { listTestFiles } from './runners/shared.mjs';
import { fileImports } from './rank.mjs';

/**
 * When a claim declares no defenders: the test files that import the fault's
 * target file, directly, by relative path or through a resolved alias. This
 * is what `nocover` measures against — no test file even imports the source.
 */
export function discoverDefenders(projectDir, targetRel) {
  return listTestFiles(projectDir).filter((t) => fileImports(projectDir, join(projectDir, t), targetRel));
}
