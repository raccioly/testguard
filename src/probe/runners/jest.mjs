import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';

export const name = 'jest';
// jest's default testMatch also collects anything under __tests__/.
export const testGlobs = [...TEST_GLOBS, '**/__tests__/**/*.js', '**/__tests__/**/*.mjs', '**/__tests__/**/*.cjs', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/__tests__/**/*.jsx'];
export const check = (opts) => checkRunner({ ...opts, pkg: 'jest', bin: 'jest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
// --runTestsByPath: positionals are exact paths, not regexes — a path with `+` or `(` would otherwise silently match nothing.
/** The command line, as data. Exported so it is falsifiable without spawning anything. */
export const argvFor = (projectDir, files, outFile, { serial = false } = {}) =>
  [...runnerArgv(projectDir, 'jest', 'jest'), '--ci', '--json', `--outputFile=${outFile}`, ...(serial ? ['--runInBand'] : []), '--runTestsByPath', ...files];
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, opts) });

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';
