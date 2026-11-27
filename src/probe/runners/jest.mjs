import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { sha256 } from '../../util/hash.mjs';
import { TEST_GLOBS, JS_EXTENSIONS, runProcess, checkRunner, runnerArgv, listTestFiles } from './shared.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryProcess } from './discovery.mjs';

export const name = 'jest';
export const extensions = JS_EXTENSIONS;
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
/**
 * Ask Jest which tests reach `target` (#334): `jest --listTests --json
 * --findRelatedTests <target>`. Jest resolves with the project's own
 * `moduleNameMapper`, `modulePaths`, `roots`, preset and custom `resolver`, so
 * the answer holds however resolution is configured. The target goes last and
 * absolute, so it can never be read as a flag. `--passWithNoTests` makes "no
 * test reaches it" a successful empty list rather than an exit code.
 */
export const relatedArgvFor = (projectDir, target) =>
  [...runnerArgv(projectDir, 'jest', 'jest'), '--listTests', '--json', '--runInBand', '--passWithNoTests', '--findRelatedTests', isAbsolute(target) ? target : join(projectDir, target)];

/**
 * The project files Jest lists as related to `target`, relative to the project.
 * A path outside the project (a file Jest resolved through a linked package) is
 * dropped: it is not a defender this project owns. A listing that is not a
 * JSON array of strings is an error, never an empty answer.
 */
export async function relatedTests({ projectDir, target, timeoutMs, maxOutputBytes, env } = {}) {
  const result = await runDiscoveryProcess({ projectDir, argv: relatedArgvFor(projectDir, target), timeoutMs, maxOutputBytes, env });
  const reported = parseDiscoveryOutput(result.stdout);
  if (reported.some((file) => typeof file !== 'string' || file.length === 0)) throw new DiscoveryError('Jest related-tests output has a malformed file path');
  const inside = [];
  for (const file of reported) {
    try { inside.push(...normalizeDiscoveredFiles(projectDir, [file])); } catch { /* outside the project, or not a file: not a defender of ours */ }
  }
  return [...new Set(inside)].sort();
}

/** One hash of everything Jest's discovery reads (config files and what they import); the cache key for related-tests answers. */
export const discoveryConfigHash = (projectDir) => sha256(JSON.stringify(hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES)));

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
