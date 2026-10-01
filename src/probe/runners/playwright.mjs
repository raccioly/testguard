import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runProcess, listTestFiles, firstInformativeLine, runnerArgv } from './shared.mjs';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs, normalizeDiscoveredFiles, runDiscoveryReportProcess } from './discovery.mjs';
import { globToRegExp } from '../../util/glob.mjs';

/**
 * Playwright runner. Selected **per file**, not per project: a defender that
 * lives under Playwright's `testDir` runs here, everything else runs under
 * the project runner (vitest/jest). One claim may list both kinds. Selected
 * for the whole project only with `--runner playwright`.
 *
 * Report protocol: `--reporter=json` with the JSON written to a file we name
 * (PLAYWRIGHT_JSON_OUTPUT_FILE; the older PLAYWRIGHT_JSON_OUTPUT_NAME is set
 * too), never parsed from stdout. Playwright's test statuses map onto the
 * spec's testRun as follows, and the mapping is the point of the adapter:
 *
 *   expected            → passed
 *   unexpected/failed   → failed, counts toward assertionFailures (can kill)
 *   unexpected/timedOut → failed, counts toward timeouts (never a kill)
 *   flaky               → failed on an attempt and passed on retry: the run
 *                         is NOT green. Counted as failed with neither an
 *                         assertion failure nor a timeout, so a green-looking
 *                         exit code becomes FLAKY-DEFENDER through the
 *                         ordinary N-run rules, exactly as GATE-SEMANTICS says.
 *   skipped             → neither passed nor failed
 */

export const name = 'playwright';

const CONFIG_FILES = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];
const SPEC_GLOBS = ['**/*.spec.js', '**/*.spec.mjs', '**/*.spec.cjs', '**/*.spec.ts', '**/*.spec.mts', '**/*.spec.tsx', '**/*.spec.jsx',
  '**/*.test.js', '**/*.test.mjs', '**/*.test.cjs', '**/*.test.ts', '**/*.test.mts', '**/*.test.tsx', '**/*.test.jsx'];

const configCache = new Map();

/**
 * The project's Playwright config, read as text (it may be TypeScript, so it
 * is never imported): `{ path, testDir }` or null when there is none.
 * `testDir` defaults to the config's own directory, as Playwright does.
 */
export function loadConfig(projectDir) {
  if (configCache.has(projectDir)) return configCache.get(projectDir);
  let out = null;
  for (const f of CONFIG_FILES) {
    const path = join(projectDir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const m = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text);
    const testDir = relative(projectDir, resolve(projectDir, m ? m[2] : '.')).split(sep).join('/') || '.';
    out = { path: f, testDir };
    break;
  }
  configCache.set(projectDir, out);
  return out;
}

/** Clear the config cache (tests create and delete projects at the same paths). */
export const resetConfigCache = () => configCache.clear();

export const testGlobs = SPEC_GLOBS;
const SPEC_RES = SPEC_GLOBS.map(globToRegExp);

/** Does this test file belong to Playwright: is there a config, and does the file live under its testDir? */
export function owns(projectDir, file) {
  const cfg = loadConfig(projectDir);
  if (!cfg) return false;
  if (!SPEC_RES.some((re) => re.test(file))) return false;
  return cfg.testDir === '.' ? true : file.startsWith(cfg.testDir + '/');
}

/**
 * Resolvable = a config exists AND `@playwright/test` resolves from the
 * project. Deliberately not `npx --no-install playwright --version`: the npx
 * cache and a Python `playwright` on PATH both answer that from a project
 * that has no Playwright at all, and `playwright test` would then run
 * against nothing. The package `playwright test` needs is the precondition.
 */
export async function check({ projectDir }) {
  const cfg = loadConfig(projectDir);
  if (!cfg) return { ok: false, message: 'no playwright.config.* in the project' };
  try {
    const pkg = JSON.parse(readFileSync(createRequire(join(projectDir, 'noop.js')).resolve('@playwright/test/package.json'), 'utf8'));
    return { ok: true, version: pkg.version };
  } catch {
    return { ok: false, message: '@playwright/test is not installed in the project (npm i -D @playwright/test)' };
  }
}

export const tests = (projectDir) => listTestFiles(projectDir, SPEC_GLOBS).filter((f) => owns(projectDir, f));
const DISCOVERY_CONFIG_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `playwright.config.${ext}`);

/** Ask Playwright itself to load config/projects and list without executing. */
export const discoveryArgvFor = (projectDir) => [...runnerArgv(projectDir, '@playwright/test', 'playwright'), 'test', '--list', '--reporter=json'];

export function parseDiscoveryReport(report) {
  if (report == null || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.suites)) {
    throw new DiscoveryError('Playwright discovery report must contain a suites array');
  }
  if (report.errors !== undefined && !Array.isArray(report.errors)) {
    throw new DiscoveryError('Playwright discovery report errors must be an array');
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    const message = report.errors.map((error) => error?.message ?? String(error)).find(Boolean);
    throw new DiscoveryError(`Playwright discovery failed${message ? `: ${firstInformativeLine(message)}` : ''}`);
  }
  const files = [];
  const walk = (suite) => {
    if (typeof suite?.file === 'string' && suite.file.length > 0) files.push(suite.file);
    for (const spec of suite?.specs ?? []) {
      if (typeof spec?.file === 'string' && spec.file.length > 0) files.push(spec.file);
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return files;
}

export async function discoverTests({ projectDir, version, timeoutMs, maxOutputBytes } = {}) {
  const before = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  const { report } = await runDiscoveryReportProcess({
    projectDir,
    argv: discoveryArgvFor(projectDir),
    timeoutMs,
    maxOutputBytes,
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: '{out}', PLAYWRIGHT_JSON_OUTPUT_NAME: '{out}' },
  });
  const configFiles = hashDiscoveryConfigs(projectDir, DISCOVERY_CONFIG_FILES);
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError('Playwright discovery config changed while tests were being listed');
  const cfg = loadConfig(projectDir);
  const reported = parseDiscoveryReport(report).map((file) => {
    if (isAbsolute(file)) return file;
    const fromRoot = resolve(projectDir, file);
    const fromTestDir = resolve(projectDir, cfg?.testDir ?? '.', file);
    const rootExists = existsSync(fromRoot);
    const testDirExists = existsSync(fromTestDir);
    if (rootExists && testDirExists && fromRoot !== fromTestDir) {
      throw new DiscoveryError(`Playwright discovery path is ambiguous between the project and testDir: ${file}`);
    }
    if (testDirExists) return fromTestDir;
    return file;
  });
  const files = normalizeDiscoveredFiles(projectDir, reported);
  return createDiscoveryManifest({ runner: name, version, files, configFiles });
}

/**
 * Playwright's JSON report → the spec's testRun. Pure; exported for the
 * sample-driven tests. `durationMs` is the wall clock measured by the runner.
 */
export function parseReport(report, durationMs) {
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        tests.push({ id: `${suite.file ?? spec.file ?? ''}::${spec.title}`, status: t.status, finalResult: last?.status, error: results.find((r) => r.error)?.error?.message });
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);

  const expected = tests.filter((t) => t.status === 'expected').length;
  const unexpected = tests.filter((t) => t.status === 'unexpected');
  const flaky = tests.filter((t) => t.status === 'flaky').length;
  const timeouts = unexpected.filter((t) => t.finalResult === 'timedOut' || t.finalResult === 'interrupted').length;
  const assertionFailures = unexpected.length - timeouts;
  const failedTests = [...unexpected, ...tests.filter((t) => t.status === 'flaky')].map((t) => t.id);
  const total = tests.length;
  const summary = { total, passed: expected, failed: unexpected.length + flaky };

  const globalErrors = report.errors ?? [];
  let outcome;
  if (total === 0) outcome = 'error';
  else if (unexpected.length > 0 || flaky > 0) outcome = 'fail';
  else outcome = 'pass';
  const loadMessage = outcome === 'error'
    ? (globalErrors.length ? firstInformativeLine(globalErrors.map((e) => e.message ?? '').join('\n')) : 'playwright found no tests')
    : undefined;
  return { run: { outcome, tests: summary, assertionFailures, durationMs }, timeouts, loadMessage, failedTests, flaky };
}

export const run = (opts) => {
  const env = { PLAYWRIGHT_JSON_OUTPUT_FILE: '{out}', PLAYWRIGHT_JSON_OUTPUT_NAME: '{out}' };
  return runProcess({ ...opts, env, parse: parseReport, argv: (files) => argvFor(opts.projectDir, files, opts) });
};

/**
 * The negative control's edit: content this runner's loader cannot possibly
 * parse. Used to prove the defenders actually execute a file before a
 * `survived` verdict about it is allowed to stand. An unterminated group is
 * a syntax error at every JavaScript/TypeScript parser, whatever the file
 * contained before.
 */
export const fatalEdit = () => '/* testguard negative control: this file must not parse */\n(\n';

/** Run the project-pinned CLI directly, avoiding an npm subprocess per confirmation. */
export const argvFor = (projectDir, files, { serial = false, workers = 1 } = {}) =>
  [...runnerArgv(projectDir, '@playwright/test', 'playwright'), 'test', '--reporter=json', `--workers=${serial ? 1 : workers}`, ...files];
