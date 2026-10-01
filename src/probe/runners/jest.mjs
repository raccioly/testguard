import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_GLOBS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryProcess } from './discovery.mjs';

export const name = 'jest';
// jest's default testMatch also collects anything under __tests__/.
export const testGlobs = [...TEST_GLOBS, '**/__tests__/**/*.js', '**/__tests__/**/*.mjs', '**/__tests__/**/*.cjs', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/__tests__/**/*.jsx'];
const DISCOVERY_CONFIG_FILES = ['js', 'mjs', 'cjs', 'ts', 'cts', 'json'].map((ext) => `jest.config.${ext}`);
export async function check(opts) {
  const result = await checkRunner({ ...opts, pkg: 'jest', bin: 'jest' });
  if (!result.ok) return result;
  const hasProjectConfig = ['package.json', ...DISCOVERY_CONFIG_FILES].some((file) => existsSync(join(opts.projectDir, file)));
  return hasProjectConfig ? result : { ok: false, message: 'no package.json or jest.config.* in the project' };
}
export const tests = (projectDir) => listTestFiles(projectDir, testGlobs);
/** Ask Jest itself to load config/projects and enumerate the files it would collect. */
export const discoveryArgvFor = (projectDir) => [...runnerArgv(projectDir, 'jest', 'jest'), '--listTests', '--json', '--runInBand'];

export function parseDiscoveryOutput(stdout) {
  let files;
  try {
    files = JSON.parse(stdout);
  } catch (error) {
    throw new DiscoveryError(`Jest discovery output is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(files)) throw new DiscoveryError('Jest discovery output must be a JSON array');
  return files;
}

export async function discoverTests({ projectDir, version, timeoutMs, maxOutputBytes } = {}) {
  const before = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  const result = await runDiscoveryProcess({ projectDir, argv: discoveryArgvFor(projectDir), timeoutMs, maxOutputBytes });
  const configFiles = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError('Jest discovery config changed while tests were being listed');
  const files = normalizeDiscoveredFiles(projectDir, parseDiscoveryOutput(result.stdout));
  return createDiscoveryManifest({ runner: name, version, files, configFiles });
}
// --runTestsByPath: positionals are exact paths, not regexes — a path with `+` or `(` would otherwise silently match nothing.
/** The command line, as data. Exported so it is falsifiable without spawning anything. */
export const argvFor = (projectDir, files, outFile, { serial = false, workers = 1 } = {}) =>
  [...runnerArgv(projectDir, 'jest', 'jest'), '--ci', '--json', `--outputFile=${outFile}`, ...(serial || workers === 1 ? ['--runInBand'] : [`--maxWorkers=${workers}`]), '--runTestsByPath', ...files];
export const run = (opts) => runProcess({ ...opts, argv: (files, outFile) => argvFor(opts.projectDir, files, outFile, opts) });

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';
