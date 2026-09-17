import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkRunner({ ...opts, pkg: 'vitest', bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
// --serial: one file at a time in one process, so a contended machine cannot turn a slow suite into a TIMEOUT verdict.
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => [...runnerArgv(opts.projectDir, 'vitest', 'vitest'), 'run', ...files, '--reporter=json', `--outputFile=${outFile}`, ...(opts.serial ? ['--no-file-parallelism'] : [])] });
