import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryProcess } from './discovery.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkRunner({ ...opts, pkg: 'vitest', bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
const DISCOVERY_CONFIG_FILES = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `vitest.workspace.${ext}`]),
  'vitest.workspace.json',
];
/** Ask Vitest itself to load config and enumerate the files it would collect. */
export const discoveryArgvFor = (projectDir) => [...runnerArgv(projectDir, 'vitest', 'vitest'), 'list', '--filesOnly', '--passWithNoTests', '--maxWorkers=1'];

export function parseDiscoveryOutput(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('Vitest discovery output must be text');
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

export async function discoverTests({ projectDir, version, timeoutMs, maxOutputBytes } = {}) {
  const before = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  const result = await runDiscoveryProcess({ projectDir, argv: discoveryArgvFor(projectDir), timeoutMs, maxOutputBytes });
  const configFiles = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError('Vitest discovery config changed while tests were being listed');
  const files = normalizeDiscoveredFiles(projectDir, parseDiscoveryOutput(result.stdout));
  return createDiscoveryManifest({ runner: name, version, files, configFiles });
}
// --serial: one file at a time in one process, so a contended machine cannot turn a slow suite into a TIMEOUT verdict.
/** The command line, as data. Exported so it is falsifiable without spawning anything. */
export const argvFor = (projectDir, files, outFile, { serial = false, workers = 1 } = {}) =>
  [...runnerArgv(projectDir, 'vitest', 'vitest'), 'run', ...files, '--reporter=json', `--outputFile=${outFile}`, `--maxWorkers=${serial ? 1 : workers}`, ...(serial || workers === 1 ? ['--no-file-parallelism'] : [])];
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, opts) });

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';
