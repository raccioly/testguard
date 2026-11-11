import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchRoot } from '../../scratch-dir.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles, parseReport, resolveRunner } from './shared.mjs';
import { nearestNodeModulesWritable } from '../node-modules-link.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryProcess } from './discovery.mjs';

export const name = 'vitest';
export const testGlobs = TEST_GLOBS;
export const check = (opts) => checkRunner({ ...opts, pkg: 'vitest', bin: 'vitest' });
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
const DISCOVERY_CONFIG_FILES = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].flatMap((ext) => [`vitest.config.${ext}`, `vite.config.${ext}`, `vitest.workspace.${ext}`]),
  'vitest.workspace.json',
];
/**
 * Discovery runs in the caller's own tree, whose node_modules cannot be swapped
 * for a scratch one. Vitest's default config loader bundles the config to a
 * temp file under `node_modules/.vite-temp` and dies with EACCES when that
 * install is read-only (a confined container). `--configLoader runner` loads
 * it in process and writes nothing; verified on vitest 5.0.2. It is asked for
 * only when the install is not writable (so a writable project keeps the
 * loader it always had) and only on a vitest that has the flag (4 and later).
 */
export const configLoaderArgs = (projectDir) => {
  const major = Number.parseInt(resolveRunner({ projectDir, pkg: 'vitest', bin: 'vitest' })?.version ?? '', 10);
  return major >= 4 && nearestNodeModulesWritable(projectDir) === false ? ['--configLoader', 'runner'] : [];
};

/** Ask Vitest itself to load config and enumerate the files it would collect. */
export const discoveryArgvFor = (projectDir) => [...runnerArgv(projectDir, 'vitest', 'vitest'), 'list', '--filesOnly', '--passWithNoTests', '--maxWorkers=1', ...configLoaderArgs(projectDir)];

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
  [...runnerArgv(projectDir, 'vitest', 'vitest'), 'run', ...files, '--reporter=json', `--reporter=${KINDS_REPORTER}`, `--outputFile=${outFile}`, `--maxWorkers=${serial ? 1 : workers}`, ...(serial || workers === 1 ? ['--no-file-parallelism'] : [])];
/**
 * vitest's JSON report keeps only error stack text, so a second, injected
 * reporter records each failed test's structured error identity in a sidecar
 * file. Missing or unreadable sidecar: every failure is an exception, which
 * is the pessimistic side. A `--runner-cmd` never gets it.
 */
export const KINDS_REPORTER = join(dirname(fileURLToPath(import.meta.url)), 'vitest', 'kinds-reporter.mjs');

export async function run(opts) {
  const sidecar = join(scratchRoot(), `testguard-vitest-kinds-${randomBytes(6).toString('hex')}.json`);
  const readKinds = () => {
    try { return existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : undefined; } catch { return undefined; }
  };
  try {
    return await runProcess({ ...opts, env: { ...opts.env, TESTGUARD_VITEST_KINDS: sidecar }, parse: (report, durationMs) => parseReport(report, durationMs, readKinds()), argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, opts) });
  } finally { rmSync(sidecar, { force: true }); }
}

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';
