import { TEST_GLOBS, npx, runProcess, checkBinary, listTestFiles } from './shared.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkBinary({ ...opts, bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => [npx, 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${outFile}`] });
