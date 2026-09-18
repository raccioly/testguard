import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkRunner({ ...opts, pkg: 'vitest', bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
// --serial: one file at a time in one process, so a contended machine cannot turn a slow suite into a TIMEOUT verdict.
/** The command line, as data. Exported so it is falsifiable without spawning anything. */
export const argvFor = (projectDir, files, outFile, { serial = false } = {}) =>
  [...runnerArgv(projectDir, 'vitest', 'vitest'), 'run', ...files, '--reporter=json', `--outputFile=${outFile}`, ...(serial ? ['--no-file-parallelism'] : [])];
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, opts) });
