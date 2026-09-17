import { TEST_GLOBS, npx, runProcess, checkBinary, listTestFiles } from './shared.mjs';

export const name = 'jest';
// jest's default testMatch also collects anything under __tests__/.
export const testGlobs = [...TEST_GLOBS, '**/__tests__/**/*.js', '**/__tests__/**/*.mjs', '**/__tests__/**/*.cjs', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/__tests__/**/*.jsx'];
export const check = (opts) => checkBinary({ ...opts, bin: 'jest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
// --runTestsByPath: positionals are exact paths, not regexes — a path with `+` or `(` would otherwise silently match nothing.
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => [npx, 'jest', '--ci', '--json', `--outputFile=${outFile}`, '--runTestsByPath', ...files] });
