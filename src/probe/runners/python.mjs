import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, listTestFiles, firstInformativeLine } from './shared.mjs';

/**
 * The Python runner. Selected **per file**: any `.py` defender runs here
 * whatever the project runner is, which is what makes a repository holding
 * both a JavaScript and a Python package probeable in one run. Selected for
 * the whole project by `--runner python|pytest|unittest`, or by `auto` when
 * neither vitest nor jest resolves.
 *
 * Two engines, one adapter. `pytest` when the project's interpreter can import
 * it, stdlib `unittest` otherwise — and `unittest` is not a fallback for the
 * poor: it is the only engine that runs on a project whose test dependencies
 * are the standard library, which is a deliberate choice in exactly the
 * codebases most worth probing. The engine that ran is what the evidence
 * records as `runner.name`; TestGuard never says pytest ran when it did not.
 *
 * Neither engine is installed into the project. The reporters live in
 * `runners/python/` inside this package and reach the interpreter through
 * PYTHONPATH — `-p _testguard_pytest_plugin` for pytest, `-m
 * _testguard_unittest_main` for unittest. The project's dependency set is
 * never touched.
 *
 * Report protocol: TestGuard's own JSON shape (see `python/_testguard_report.py`),
 * written to a file named by `TESTGUARD_REPORT`, never parsed from stdout —
 * `unittest` writes its summary to stderr where it interleaves with whatever
 * the tests print, and reading that stream is how hand-rolled harnesses come
 * to report a red suite as green.
 *
 * Python outcomes map onto the spec's testRun as follows:
 *
 *   passed              → passed
 *   failed              → failed, counts toward assertionFailures (can kill).
 *                         An `AssertionError` and a `TypeError` raised by the
 *                         test body are alike here, as they are under jest:
 *                         both are the suite rejecting the behaviour. The
 *                         exception class is reported, never scored.
 *   failed, timed out   → failed, counts toward timeouts (never a kill)
 *   xfail               → neither passed nor failed
 *   xpass               → the suite's own expectation is wrong, so the run is
 *                         NOT green — counted as failed with no assertion
 *                         failure, so it reaches FLAKY-DEFENDER through the
 *                         ordinary N-run rules rather than killing anything
 *   skipped             → neither passed nor failed
 *   collection error    → the suite could not load: `error`, never a kill.
 *                         This is what a fault whose replacement does not
 *                         parse looks like from Python, and it is how
 *                         `fault-invalid` is reached.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const PYTHON_DIR = join(HERE, 'python');

export const name = 'python';

/**
 * pytest's default `python_files`, plus unittest's default discovery pattern
 * (`test*.py`). A helper named `testutils.py` matches and collects nothing,
 * which costs a little; a test file that did not match would be invisible to
 * discovery and report `nocover`, which costs the truth.
 */
export const testGlobs = ['**/test_*.py', '**/test*.py', '**/*_test.py'];

const PY_FILE = /\.py$/;
const TIMEOUT = /\bTimeout >|\btimed out\b|\bTimeoutError\b/i;

/**
 * Interpreters to try, best first: the active virtualenv, the project's own,
 * then PATH.
 *
 * An explicit `--python` is NOT one of these. It is the only candidate, and it
 * is returned alone: an interpreter the user named and TestGuard quietly
 * replaced with another would change which dependencies the tests ran against
 * without changing anything the evidence says.
 */
function candidates(projectDir, python) {
  const out = [];
  const win = process.platform === 'win32';
  const binOf = (root) => (win ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python'));
  const explicit = python ?? process.env.TESTGUARD_PYTHON;
  if (explicit) return [{ path: explicit, source: 'project', explicit: true }];
  if (process.env.VIRTUAL_ENV) out.push({ path: binOf(process.env.VIRTUAL_ENV), source: 'project' });
  for (const dir of ['.venv', 'venv', '.env']) out.push({ path: binOf(join(projectDir, dir)), source: 'project' });
  out.push({ path: win ? 'python.exe' : 'python3', source: 'path' });
  out.push({ path: win ? 'py.exe' : 'python', source: 'path' });
  return out;
}

const PROBE = [
  'import json,sys',
  'v=".".join(map(str,sys.version_info[:3]))',
  'try:',
  ' import pytest; p=pytest.__version__',
  'except Exception: p=None',
  'print(json.dumps({"python":v,"pytest":p}))',
].join('\n');

const interpreters = new Map(); // projectDir -> resolution promise

/** Forget resolved interpreters (tests create and delete projects at the same paths). */
export const resetInterpreterCache = () => interpreters.clear();

/**
 * Ask an interpreter what it is and whether it can import pytest.
 *
 * Deliberately NOT run with `-I`. Isolated mode ignores `PYTHONPATH` and the
 * user site directory, so it would answer "no pytest" for an interpreter that
 * will import pytest perfectly well during the actual run — and TestGuard
 * would silently choose the stdlib engine for a suite written in pytest, which
 * then collects nothing. The check has to see what the run will see.
 */
function ask(path, budgetMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, ['-c', PROBE], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    } catch {
      return resolve(null);
    }
    let out = '';
    child.on('error', () => resolve(null));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The interpreter this project's tests run under, and whether it can import
 * pytest. Resolved against the **original** project directory, never the
 * scratch worktree: a virtualenv is gitignored, so it is not in the worktree
 * checkout, and it is referenced by absolute path the way virtualenvs are
 * meant to be — never copied and never symlinked, which would break the
 * `pyvenv.cfg` prefix detection that makes one work at all.
 */
export function resolveInterpreter({ projectDir, python, budgetMs = 30_000 }) {
  const key = `${projectDir}\0${python ?? ''}`;
  if (interpreters.has(key)) return interpreters.get(key);
  const task = (async () => {
    const tried = [];
    for (const candidate of candidates(projectDir, python)) {
      if (!candidate.explicit && candidate.source === 'project' && !existsSync(candidate.path)) continue;
      const answer = await ask(candidate.path, budgetMs);
      if (answer) return { ...candidate, ...answer };
      tried.push(candidate.path);
    }
    const explicit = python ?? process.env.TESTGUARD_PYTHON;
    return { error: explicit
      ? `${explicit} is not a usable Python interpreter`
      : `no usable Python interpreter (tried ${tried.join(', ') || 'nothing'}); install Python 3.8+, or point --python / TESTGUARD_PYTHON at one` };
  })();
  interpreters.set(key, task);
  return task;
}

/**
 * Resolvable = an interpreter answers, and — when an engine is pinned — that
 * engine is available. `--runner pytest` on a machine that has no pytest is a
 * precondition failure, never a silent fall back to unittest: which engine ran
 * changes what the evidence means.
 */
/**
 * Which engine runs, given what the interpreter answered.
 *
 * Pure, and separate from the spawn, because the interesting branch is the one
 * that is hard to stage: an interpreter that resolves but cannot import
 * pytest. Testing that through `check()` would mean building a bare virtualenv
 * inside a unit test, so the decision is lifted out and the spawn is left with
 * nothing to decide.
 */
export function chooseEngine(pinned, found) {
  const engine = pinned ?? (found.pytest ? 'pytest' : 'unittest');
  if (engine === 'pytest' && !found.pytest) {
    return { ok: false, message: `pytest is not importable from ${found.path} (pip install pytest, or use --runner unittest for the stdlib runner)` };
  }
  return { ok: true, engine, version: engine === 'pytest' ? found.pytest : `CPython ${found.python}` };
}

export function makeCheck(pinned) {
  return async ({ projectDir, sourceDir, python, budgetMs = 30_000 }) => {
    // Always the ORIGINAL project directory when there is one: a virtualenv is
    // gitignored, so the scratch worktree does not contain it.
    const found = await resolveInterpreter({ projectDir: sourceDir ?? projectDir, python, budgetMs });
    if (found.error) return { ok: false, message: found.error };
    const chosen = chooseEngine(pinned, found);
    if (!chosen.ok) return chosen;
    return { ...chosen, interpreter: found.path, source: found.source };
  };
}

/** Any `.py` file. A Python test can never run under vitest, so ownership needs no configuration to read. */
export const owns = (projectDir, file) => PY_FILE.test(file);

export const tests = (projectDir) => listTestFiles(projectDir, testGlobs).filter((f) => owns(projectDir, f));

/**
 * TestGuard's Python report → the spec's testRun. Pure; exported for the
 * sample-driven tests. `provenance` rides along for the import check that
 * `probe` performs once the fault is live; it is not part of the testRun.
 */
export function parseReport(report, durationMs) {
  const all = report.tests ?? [];
  const collectionErrors = report.collectionErrors ?? [];
  const failed = all.filter((t) => t.outcome === 'failed');
  const timedOut = failed.filter((t) => TIMEOUT.test(t.message ?? ''));
  const xpass = all.filter((t) => t.outcome === 'xpass');
  const passed = all.filter((t) => t.outcome === 'passed').length;
  const total = all.length;
  const summary = { total, passed, failed: failed.length + xpass.length };

  let outcome;
  if (collectionErrors.length > 0 || total === 0) outcome = 'error';
  else if (failed.length > 0 || xpass.length > 0) outcome = 'fail';
  else outcome = 'pass';

  const loadMessage = outcome === 'error'
    ? (collectionErrors.length
      ? firstInformativeLine(collectionErrors.map((e) => e.message ?? '').join('\n'))
      : 'python collected no tests')
    : undefined;

  return {
    run: { outcome, tests: summary, assertionFailures: failed.length - timedOut.length, durationMs },
    timeouts: timedOut.length,
    loadMessage,
    failedTests: [...failed, ...xpass].map((t) => t.id),
    provenance: report.provenance ?? {},
  };
}

/**
 * Environment for one run. Three things matter beyond finding the reporter:
 *
 *   PYTHONDONTWRITEBYTECODE + PYTHONPYCACHEPREFIX — `.pyc` files are validated
 *     by the source's mtime **in whole seconds** and its size. A fault that
 *     preserves the byte length and is applied within the same second as the
 *     file it replaces can therefore be served from a stale cache and never
 *     execute: a green run that proves nothing. The prefix moves every cache
 *     lookup out of the tree, so an `--in-place` run cannot read the user's
 *     existing `__pycache__` either, and DONTWRITEBYTECODE means the prefix
 *     directory is never actually created.
 *
 *   TESTGUARD_TARGETS — the fault's file, so the reporter can say which file
 *     the interpreter really loaded for it.
 */
export function environment(targets) {
  const existing = process.env.PYTHONPATH;
  return {
    PYTHONPATH: existing ? `${PYTHON_DIR}${process.platform === 'win32' ? ';' : ':'}${existing}` : PYTHON_DIR,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: '{out}.pycache',
    PYTHONUNBUFFERED: '1',
    TESTGUARD_REPORT: '{out}',
    TESTGUARD_TARGETS: JSON.stringify(targets ?? []),
  };
}

/**
 * `--maxfail=0` is appended on every pytest run, and is not optional: a
 * project whose `addopts` carries `-x` would otherwise stop at the first
 * failure. The verdict would survive that (one assertion failure is still a
 * kill) but the list of failing tests would not, and that list is what names
 * an undeclared killer during escalation. `0` means no limit and overrides
 * the configured value; the rest of the project's `addopts` is left alone,
 * because TestGuard runs a project's tests the way the project runs them.
 */
export function argvFor({ engine, interpreter, files, serial }) {
  if (engine === 'pytest') {
    return [interpreter, '-m', 'pytest', '-p', '_testguard_pytest_plugin', '-p', 'no:cacheprovider',
      '--maxfail=0', '-q', ...(serial ? ['-p', 'no:xdist'] : []), ...files];
  }
  return [interpreter, '-m', '_testguard_unittest_main', ...files];
}

export function makeRun(pinned) {
  const check = makeCheck(pinned);
  return async (opts) => {
    const resolved = await check({ projectDir: opts.sourceDir ?? opts.projectDir, python: opts.python });
    if (!resolved.ok) {
      return { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, durationMs: 0 }, timeouts: 0, loadMessage: resolved.message, failedTests: [], provenance: {} };
    }
    return runProcess({
      ...opts,
      env: environment(opts.targets),
      parse: parseReport,
      argv: (files) => argvFor({ engine: resolved.engine, interpreter: resolved.interpreter, files, serial: opts.serial }),
    });
  };
}

export const check = makeCheck(null);
export const run = makeRun(null);

/** `--runner pytest` / `--runner unittest`: the same adapter with the engine pinned. */
export function pinned(engine) {
  return { name: engine, testGlobs, owns, tests, parseReport, check: makeCheck(engine), run: makeRun(engine) };
}

/**
 * The negative control's edit, for Python: an unterminated group, which is a
 * `SyntaxError` at import time whatever the module contained. See the
 * JavaScript runners for why this exists.
 */
export const fatalEdit = () => '# testguard negative control: this file must not parse\n(\n';
