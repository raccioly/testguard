import * as vitest from './vitest.mjs';
import * as jest from './jest.mjs';
import * as playwright from './playwright.mjs';
import * as pythonRunner from './python.mjs';

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
};

export const RUNNER_NAMES = ['vitest', 'jest', 'playwright', 'python', 'pytest', 'unittest'];

/**
 * Runners that own files rather than projects: a defender under Playwright's
 * testDir runs under Playwright, and a `.py` defender runs under Python,
 * whatever the project runner is. That is what makes a repository holding
 * both a JavaScript and a Python package probeable in one run. `auto` may
 * still pick Python as the project runner when no JavaScript runner resolves;
 * it never picks Playwright, which needs a config to mean anything.
 */
export const OWNED_RUNNERS = [playwright, pythonRunner];

/**
 * Pick the project runner: an explicit name, or the first of vitest, jest,
 * python that is resolvable from the project. Returns
 * { runner, version, source, engine } or { error }. `engine` is set when the
 * runner has more than one (Python: pytest or unittest) and names the one
 * that will actually run — it, not the module name, is what the evidence
 * records.
 */
export async function selectRunner({ projectDir, sourceDir, python, name = 'auto' }) {
  const candidates = name === 'auto' ? [vitest, jest, pythonRunner] : [RUNNERS[name]];
  if (!candidates[0]) return { error: `unknown runner "${name}"; use ${RUNNER_NAMES.join(', ')} or auto` };
  const messages = [];
  for (const r of candidates) {
    const c = await r.check({ projectDir, sourceDir, python });
    if (c.ok) return { runner: r, version: c.version, source: c.source, engine: c.engine };
    messages.push(`${r.name}: ${c.message}`);
  }
  return { error: messages.join('; ') };
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

/**
 * Merge the runs of several runners into one testRun, pessimistically: any
 * load error is an error, any timeout is a timeout, any failure is a failure.
 * Counts add; failed test ids concatenate.
 */
export function mergeRuns(parts) {
  if (parts.length === 1) return parts[0];
  // Import provenance is per-target and never contradictory between runners:
  // only the Python runner reports any, and only for its own targets.
  const provenance = Object.assign({}, ...parts.map((p) => p.provenance ?? {}));
  const runs = parts.map((p) => p.run);
  const outcome = runs.some((r) => r.outcome === 'error') ? 'error' : runs.some((r) => r.outcome === 'timeout') ? 'timeout' : runs.some((r) => r.outcome === 'fail') ? 'fail' : 'pass';
  const sum = (k) => runs.reduce((n, r) => n + (r.tests[k] ?? 0), 0);
  return {
    run: { outcome, tests: { total: sum('total'), passed: sum('passed'), failed: sum('failed') }, assertionFailures: runs.reduce((n, r) => n + r.assertionFailures, 0), durationMs: runs.reduce((n, r) => n + r.durationMs, 0) },
    timeouts: parts.reduce((n, p) => n + (p.timeouts ?? 0), 0),
    loadMessage: parts.find((p) => p.loadMessage)?.loadMessage,
    failedTests: parts.flatMap((p) => p.failedTests ?? []),
    provenance,
  };
}
