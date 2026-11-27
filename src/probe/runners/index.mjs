import * as vitest from './vitest.mjs';
import * as jest from './jest.mjs';
import * as playwright from './playwright.mjs';
import * as pythonRunner from './python.mjs';
import * as nodeTest from './node-test.mjs';
import * as maven from './maven.mjs';
import * as gradle from './gradle.mjs';
import * as karma from './karma.mjs';
import { detectKarma } from './karma.mjs';
import { BUILD_MARKERS } from '../../gate/languages.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDiscoveryManifest, DiscoveryError, hashDiscoveryConfigs } from './discovery.mjs';

export const RUNNERS = {
  vitest,
  jest,
  playwright,
  python: pythonRunner,
  // The same adapter with its engine pinned: `--runner pytest` fails rather
  // than falling back to unittest, because which engine ran changes what the
  // evidence means.
  pytest: pythonRunner.pinned('pytest'),
  unittest: pythonRunner.pinned('unittest'),
  'node-test': nodeTest,
  // The build-system adapters (#329): explicit only, never chosen by `auto`.
  maven,
  gradle,
  karma,
};

export const RUNNER_NAMES = ['vitest', 'jest', 'playwright', 'python', 'pytest', 'unittest', 'node-test', 'maven', 'gradle', 'karma'];

/**
 * Runners that own files rather than projects: a defender under Playwright's
 * testDir runs under Playwright, and a `.py` defender runs under Python,
 * whatever the project runner is. That is what makes a repository holding
 * both a JavaScript and a Python package probeable in one run. `auto` may
 * still pick Python as the project runner when no JavaScript runner resolves;
 * it never picks Playwright, which needs a config to mean anything.
 */
export const OWNED_RUNNERS = [playwright, pythonRunner];

const PYTHON_DISCOVERY_CONFIG_FILES = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'conftest.py'];

const immutableManifest = (manifest) => Object.freeze({
  ...manifest,
  runner: Object.freeze({ ...manifest.runner }),
  files: Object.freeze([...manifest.files]),
  configFiles: Object.freeze(manifest.configFiles.map((entry) => Object.freeze({ ...entry }))),
  ...(manifest.projects ? { projects: Object.freeze(Object.fromEntries(Object.entries(manifest.projects).map(([file, names]) => [file, Object.freeze([...names])]))) } : {}),
});

export async function discoverRunnerManifest(runner, check, projectDir, budgetMs) {
  let manifest;
  if (runner.discoverTests) {
    manifest = await runner.discoverTests({ projectDir, version: check.version, ...(budgetMs === undefined ? {} : { timeoutMs: budgetMs }) });
    return immutableManifest(manifest);
  }
  // Python's adapter discovery is already language-aware but is not a native
  // subprocess listing yet. Bind its immutable universe to every conventional
  // pytest configuration input so it cannot be reused across a config edit.
  const before = hashDiscoveryConfigs(projectDir, PYTHON_DISCOVERY_CONFIG_FILES);
  const files = runner.tests(projectDir);
  const configFiles = hashDiscoveryConfigs(projectDir, PYTHON_DISCOVERY_CONFIG_FILES);
  if (JSON.stringify(configFiles) !== JSON.stringify(before)) throw new DiscoveryError(`${runner.name} discovery config changed while tests were being listed`);
  manifest = createDiscoveryManifest({ runner: runner.name, version: check.version, files, configFiles, source: 'adapter' });
  return immutableManifest(manifest);
}

const BUILD_LABELS = { maven: 'Maven', gradle: 'Gradle', karma: 'Karma' };

/**
 * The build systems a project says it uses, from its files alone: `[{ runner,
 * why }]` for `maven` (a pom.xml), `gradle` (a Gradle build file) and `karma`
 * (a karma builder or dependency). `auto` never picks these; the list is only
 * used to say what was found when nothing else resolved.
 */
export function detectBuildRunners(projectDir) {
  const found = [];
  for (const runner of ['maven', 'gradle']) {
    const marker = BUILD_MARKERS[runner].find((name) => existsSync(join(projectDir, name)));
    if (marker) found.push({ runner, why: `${marker} is in the project` });
  }
  const k = detectKarma(projectDir);
  if (k) found.push({ runner: 'karma', why: k.why });
  return found;
}

const BUILD_HOW = {
  maven: 'run it with --runner maven (a project ./mvnw or mvn on PATH)',
  gradle: 'run it with --runner gradle (a project ./gradlew or gradle on PATH)',
  karma: 'run it with --runner karma (it needs @angular/cli, karma-junit-reporter and a karma.conf.js, and starts ChromeHeadless)',
};

/** One sentence per build system found: what it is, why we think so, how to run it. */
const buildAdvice = (found) => found.map(({ runner, why }) => `${BUILD_LABELS[runner]} was found (${why}), but TestGuard does not choose it on its own: ${BUILD_HOW[runner]}, or pass --runner-cmd with --report-format junit.`).join(' ');

/**
 * The precondition message for a runner that did not resolve. The dependency
 * advice is for a missing install; a config file that cannot be parsed gets
 * only its own error (#330), and a project whose build system was found is told
 * how to run it instead of being told to install vitest.
 */
export function runnerUnresolvableMessage({ sel, mode }) {
  const where = mode === 'worktree' ? 'scratch worktree' : 'project';
  if (sel.detected) return `test runner is not resolvable in the ${where} (${sel.error})`;
  if (sel.configError) return `test runner is not resolvable in the ${where} (${sel.error}). Fix that config file; no dependency change will help.`;
  const advice = mode === 'worktree'
    ? 'If dependencies are missing, pass --node-modules <path>, or run with --in-place. Otherwise fix the discovery error above.'
    : 'If dependencies are missing, install them first. Otherwise fix the discovery error above.';
  return `test runner is not resolvable in the ${where} (${sel.error}). ${advice}`;
}

/**
 * Pick the project runner: an explicit name, or the first of vitest, jest,
 * python that is resolvable from the project. Returns
 * { runner, version, source, engine, manifest, testFiles } only after the
 * runner's immutable non-empty test universe is known, or { error }. `engine`
 * is set when the runner has more than one (Python: pytest or unittest) and
 * names the one that will actually run — it, not the module name, is what the
 * evidence records.
 */
export async function selectRunner({ projectDir, sourceDir, python, name = 'auto', budgetMs, budgetFor }) {
  const candidates = name === 'auto' ? [vitest, jest, pythonRunner] : [RUNNERS[name]];
  if (!candidates[0]) return { error: `unknown runner "${name}"; use ${RUNNER_NAMES.join(', ')} or auto` };
  const messages = [];
  // A runner that resolves but whose globs match ZERO test files is not an
  // answer. A pure TypeScript project using Playwright resolves neither vitest
  // nor jest, and `auto` then reaches python — which resolves wherever a
  // python3 exists — globs for `.py`, finds none, and reports every fault as
  // `nocover`: a damning statement about the project produced by a runner that
  // could not have seen its tests.
  //
  // So `auto` prefers a candidate that can actually see tests. An explicit
  // runner with an empty universe is also refused: choosing it knowingly does
  // not turn zero observations into evidence.
  for (const r of candidates) {
    const checkBudget = budgetFor ? budgetFor() : budgetMs;
    const c = await r.check({ projectDir, sourceDir, python, budgetFor, ...(checkBudget === undefined ? {} : { budgetMs: checkBudget }) });
    if (!c.ok) { messages.push(`${r.name}: ${c.message}`); continue; }
    let selected = { runner: r, version: c.version, source: c.source, engine: c.engine };
    let manifest;
    try {
      manifest = await discoverRunnerManifest(r, c, projectDir, budgetFor ? budgetFor() : budgetMs);
    } catch (error) {
      return { error: `${r.name}: test discovery failed: ${error.message}`, ...(error instanceof DiscoveryError && error.configUnreadable ? { configError: true } : {}) };
    }
    selected = { ...selected, manifest };
    const testFiles = manifest.files.length;
    const empty = `${r.name}: resolved but discovered no test files`;
    if (name !== 'auto' && testFiles === 0) return { error: empty };
    if (testFiles > 0 || name !== 'auto') return { ...selected, testFiles };
    messages.push(empty);
  }
  const others = messages.length ? messages.join('; ') : 'no runner discovered test files';
  // `auto` found nothing to run. A project that says it is built with Maven,
  // Gradle or Karma gets that said first, rather than advice to install vitest.
  const detected = name === 'auto' ? detectBuildRunners(projectDir) : [];
  if (detected.length) return { error: `${buildAdvice(detected)} Runners \`auto\` tried: ${others}`, detected };
  return { error: others };
}

/** What the evidence calls a runner: the engine that actually ran, else the module's name. */
export const runnerLabel = (runner, engines) => engines?.get(runner) ?? runner.name;

/** The runner a test file runs under: an owning runner if one claims it, else the project runner. */
export function runnerFor(projectDir, file, primary) {
  if (primary.owns?.(projectDir, file)) return primary;
  return OWNED_RUNNERS.find((r) => r !== primary && r.owns(projectDir, file)) ?? primary;
}

/** Group files by the runner they run under, in a stable order (primary first). */
export function partitionByRunner(projectDir, files, primary) {
  const groups = new Map([[primary, []]]);
  for (const f of files) {
    const r = runnerFor(projectDir, f, primary);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  }
  if (groups.get(primary).length === 0 && groups.size > 1) groups.delete(primary);
  return groups;
}

// Pessimistic merge of several runs; it lives beside the runners that use it.
export { mergeRuns } from './shared.mjs';
