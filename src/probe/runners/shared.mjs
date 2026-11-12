import { spawn, spawnSync } from 'node:child_process';
import { workerEnv } from '../worker-env.mjs';
import { registerChild, assertNotCancelled } from './lifecycle.mjs';
import { readBoundedJsonFile } from './discovery.mjs';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { childScope, scratchRoot } from '../../scratch-dir.mjs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { matchGlobs } from '../../util/glob.mjs';

export const TEST_GLOBS = ['**/*.test.js', '**/*.test.mjs', '**/*.test.cjs', '**/*.test.ts', '**/*.test.mts', '**/*.test.tsx', '**/*.test.jsx',
  '**/*.spec.js', '**/*.spec.mjs', '**/*.spec.cjs', '**/*.spec.ts', '**/*.spec.mts', '**/*.spec.tsx', '**/*.spec.jsx'];
export const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Node's own advisory warnings about the probed project's configuration; never about the fault. */
export const NODE_NOISE = /MODULE_TYPELESS_PACKAGE_JSON|ExperimentalWarning|--trace-warnings|Reparsing as ES module|To eliminate this warning/;

function descendantPids(rootPid) {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const visit = (pid) => { for (const child of children.get(pid) ?? []) { visit(child); out.push(child); } };
  visit(rootPid);
  return out;
}

export const TIMEOUT_CLEANUP_WARNING = 'cleanup-unverified: TestGuard hard-killed the runner process group and descendants still attributable at timeout, but an already-reparented daemon may survive; use an OS or container containment boundary for daemonizing or untrusted commands';

/**
 * Best-effort runner cleanup. POSIX process groups plus a PPID snapshot cover
 * ordinary descendants and a still-attributable detached child. Node exposes
 * no portable cgroup/job-object/subreaper primitive, so a daemon that already
 * reparented cannot be proven dead here. Callers must keep the result a
 * timeout and surface TIMEOUT_CLEANUP_WARNING rather than claiming containment.
 */
export function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 1000 });
    try { child.kill('SIGKILL'); } catch {}
    return;
  }
  // Freeze the main group before enumerating so it cannot fork between the
  // snapshot and the kill. A deliberately detached descendant is outside the
  // group but remains visible through PPID and is killed explicitly.
  try { process.kill(-child.pid, 'SIGSTOP'); } catch {}
  for (const pid of descendantPids(child.pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

/**
 * Split a runner command template into argv. Supports double and single
 * quotes; `{files}` expands to the test files (one argv entry each) and
 * `{out}` to the JSON report path. Everything else is passed through.
 */
export function splitCommandWords(template, flag = '--runner-cmd') {
  const words = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) words.push(cur);
  if (quote) throw new RangeError(`unterminated quote in ${flag}`);
  return words;
}

export function parseCommandTemplate(template) {
  const words = splitCommandWords(template);
  if (!words.includes('{files}') || !words.some((w) => w.includes('{out}'))) throw new RangeError('--runner-cmd must contain {files} (as its own word) and {out}');
  return words;
}

export const expandCommand = (words, files, outFile) => words.flatMap((w) => (w === '{files}' ? files : [w.replaceAll('{out}', outFile)]));

const resolvedRunners = new Map(); // `${projectDir}\0${pkg}` → { argv, version, source }

/**
 * Where does the runner come from? The PROJECT first: the runner package
 * resolved from `projectDir` (its version, its `bin` script run with this
 * node). Only when no package resolves, an executable on PATH — a global
 * runner is a legitimate setup for some monorepos, and the evidence says so
 * (`source: "path"`). Never `npx`: the npx cache and a same-named executable
 * (a Python `playwright` shim, say) both answer `npx --no-install <bin>
 * --version` from a project that has no such runner at all (#41).
 */
export function resolveRunner({ projectDir, pkg, bin }) {
  const key = `${projectDir}\0${pkg}`;
  if (resolvedRunners.has(key)) return resolvedRunners.get(key);
  let result = null;
  try {
    const req = createRequire(join(projectDir, 'noop.js'));
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const binField = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin?.[bin];
    if (binField) result = { argv: [process.execPath, join(dirname(pkgJsonPath), binField)], version: pkgJson.version, source: 'project' };
  } catch {}
  resolvedRunners.set(key, result);
  return result;
}

/** Forget cached resolutions (tests create and delete projects at the same paths). */
export const resetRunnerCache = () => resolvedRunners.clear();

/** The argv prefix that runs `pkg`'s `bin` for this project: the resolved local script, else the PATH executable. */
export function runnerArgv(projectDir, pkg, bin) {
  return resolveRunner({ projectDir, pkg, bin })?.argv ?? [bin];
}

/**
 * Can the runner be resolved at all from this directory? Run before any
 * verdict is attempted: an unresolvable runner is a precondition failure,
 * never a statement about the tests. Project package first; PATH second;
 * npx never.
 */
export function checkRunner({ projectDir, pkg, bin, budgetMs = 60_000, env = process.env }) {
  const local = resolveRunner({ projectDir, pkg, bin });
  if (local) return Promise.resolve({ ok: true, version: local.version, source: 'project' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.platform === 'win32' ? `${bin}.cmd` : bin, ['--version'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...env, CI: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, message: e.message });
    }
    registerChild(child, () => terminateProcessTree(child));
    let out = '';
    let err = '';
    child.on('error', () => resolve({ ok: false, message: `${pkg} is not installed in the project and \`${bin}\` is not on PATH (npm i -D ${pkg})` }));
    child.stdout.on('data', (d) => (out = (out + d).slice(-65536)));
    child.stderr.on('data', (d) => (err = (err + d).slice(-65536)));
    const timer = setTimeout(() => terminateProcessTree(child), budgetMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = out.trim().replace(/^vitest\//, '').replace(/^Version\s+/i, '').split('\n').pop();
      resolve(code === 0 && version
        ? { ok: true, version, source: 'path' }
        : { ok: false, message: `${pkg} is not installed in the project; \`${bin}\` on PATH answered: ${(err || out).trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${code}`}` });
    });
  });
}

/** @deprecated name kept for older callers; resolves the project package first, never npx. */
export const checkBinary = ({ bin, ...rest }) => checkRunner({ ...rest, pkg: bin, bin });

/** Defender globs → existing files. Empty result is the `nocover` signal. */
export const resolveDefenders = (projectDir, globs) => matchGlobs(projectDir, globs ?? []);

export const listTestFiles = (projectDir, globs = TEST_GLOBS) => matchGlobs(projectDir, globs);

/**
 * Turn vitest's JSON report into a spec `testRun`.
 *
 * `assertionFailures` + `exceptionFailures` count test-level failures that are
 * neither timeouts nor load failures — the test body ran and rejected the
 * behaviour — split by structured error identity. Only those can kill a fault. A suite that fails to load, or a test that times out, is
 * not evidence that the suite defends the claim.
 */
export function firstInformativeLine(message) {
  const lines = message.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  return lines.find((l) => /error|syntax|unexpected|expected .+ but found|cannot find|failed to parse|transform failed/i.test(l) && !/^●/.test(l)) ?? lines[0] ?? '';
}

/**
 * Is this serialized error an assertion, judged by structured identity and
 * never by message wording? `code === 'ERR_ASSERTION'`, `name ===
 * 'AssertionError'`, a string `operator` (node:assert, chai) or a jest
 * `matcherResult` all say so. One more shape is read, and it is a quirk, not
 * a contract: jest-circus rewrites the message of a node:assert error and then
 * serializes only that own, enumerable `message`, dropping `name`, `code` and
 * `operator`, while an ordinary Error serializes as `{}`. A plain object
 * thrown as `{ message }` has the same shape, so a lone `message` is an
 * assertion only when the runner's own error HEADER (the first line of the
 * matching `failureMessages` entry, never a stack frame or quoted text) says
 * so: it names the `AssertionError` class, or is jest's own assertion header,
 * `assert.<fn>(` or `expect(`. Anything else, including no detail at all, is
 * an exception.
 */
const ASSERTION_HEADER = /^(?:AssertionError\b|(?:Error: )?(?:assert|expect)\b[\w.]*\()/;
const headerOf = (message) => String(message ?? '').replace(/\x1b\[[0-9;]*m/g, '').trimStart().split('\n')[0].trimEnd();
export function isAssertionDetail(detail, message) {
  if (detail == null || typeof detail !== 'object') return false;
  if (detail.code === 'ERR_ASSERTION' || detail.name === 'AssertionError') return true;
  if (typeof detail.operator === 'string') return true;
  if (detail.matcherResult != null && typeof detail.matcherResult === 'object') return true;
  const keys = Object.keys(detail);
  return keys.length === 1 && keys[0] === 'message' && typeof detail.message === 'string' && ASSERTION_HEADER.test(headerOf(message));
}

/** A failed test is an assertion when any of its errors is one. Absent details are an exception: the pessimistic side. */
export const failureKind = (details, messages = []) => (Array.isArray(details) && details.some((d, i) => isAssertionDetail(d, messages?.[i])) ? 'assertion' : 'exception');

function isRunnerTimeout(test) {
  if (test.failureType === 'testTimeoutFailure') return true;
  const details = test.failureDetails ?? [];
  if (details.some((error) => error?.failureType === 'testTimeoutFailure')) return true;
  return (test.failureMessages ?? []).some((message, index) => {
    const error = details[index];
    // Assertion text may quote a timeout header verbatim. Inspect only the
    // error header, never stack frames, source excerpts, or expected values.
    if (error?.name === 'AssertionError' || error?.code === 'ERR_ASSERTION' || error?.operator !== undefined) return false;
    const header = String(message).replace(/\x1b\[[0-9;]*m/g, '').trimStart().split('\n')[0].trimEnd();
    return /^(?:Error:\s*)?(?:thrown:\s*")?(?:Exceeded timeout of \d+(?:\.\d+)?\s*ms for a (?:test|hook)\b|(?:Test|Hook) timed out in \d+(?:\.\d+)?ms\b|test timed out after \d+(?:\.\d+)?ms\b)/i.test(header)
      || /^(?:(?:Error|AroundHookSetupError|AroundHookTeardownError):\s*)?The (?:setup|teardown) phase of "around(?:Each|All)" hook timed out after \d+(?:\.\d+)?ms\b/.test(header);
  });
}

/**
 * `kinds` is the optional sidecar of a runner whose JSON report carries no
 * structured error identity (vitest): `{ tests: [{ file, path, kind }] }`.
 * Keyed by file and title path; a key shared by several failed tests counts as
 * an assertion only when every one of them is.
 */
function sidecarKinds(kinds) {
  const byKey = new Map();
  for (const t of kinds?.tests ?? []) {
    if (typeof t?.file !== 'string' || !Array.isArray(t.path)) continue;
    const key = JSON.stringify([t.file, t.path]);
    byKey.set(key, byKey.get(key) === 'exception' || t.kind !== 'assertion' ? 'exception' : 'assertion');
  }
  return byKey;
}

export function parseReport(report, durationMs, kinds) {
  // A report that parsed as JSON but carries no `testResults` is not a suite
  // that ran zero tests — it is a report of a shape this parser does not
  // understand, which is what `--runner-cmd` pointed at a non-jest reporter
  // produces. The verdict is already safe (a non-green baseline makes the
  // claim unverifiable rather than passing), but without this the user is told
  // `defenders-failed-to-load` with no reason at all.
  const unknownShape = report == null || typeof report !== 'object' || !Array.isArray(report.testResults);
  const files = report.testResults ?? [];
  const loadFailed = files.some((f) => f.status === 'failed' && (f.assertionResults?.length ?? 0) === 0);
  const sidecar = sidecarKinds(kinds);
  const results = files.flatMap((f) => (f.assertionResults ?? []).map((t) => ({ ...t, id: `${f.name}::${t.fullName ?? t.title ?? ''}`, sidecarKind: sidecar.get(JSON.stringify([f.name, [...(t.ancestorTitles ?? []), t.title]])) }))).filter((t) => t.status === 'failed');
  const timeouts = results.filter(isRunnerTimeout).length;
  const failedTests = results.map((t) => t.id);
  // Every failed test is exactly one of: a timeout, an assertion, an exception.
  const settled = results.filter((t) => !isRunnerTimeout(t));
  const kindOf = (t) => (t.failureDetails !== undefined ? failureKind(t.failureDetails, t.failureMessages) : t.sidecarKind);
  const assertionFailures = settled.filter((t) => kindOf(t) === 'assertion').length;
  const exceptionFailures = settled.length - assertionFailures;
  // An exception because the runner said so, or only because it reported nothing to read?
  const kindNotReported = settled.filter((t) => t.failureDetails === undefined && t.sidecarKind === undefined).length;
  const tests = { total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0 };

  let outcome;
  if (loadFailed || tests.total === 0) outcome = 'error';
  else if (report.success) outcome = 'pass';
  else outcome = 'fail';

  const run = { outcome, tests, assertionFailures, exceptionFailures, ...(kindNotReported ? { kindNotReported } : {}), durationMs };
  // jest opens a load failure with "● Test suite failed to run" and puts the
  // cause lines below; vitest puts it on the first line. Take the first line
  // that names an error, else the first non-empty one.
  // An `error` run always says why (#291): the runner's own line when it gave one, else a fixed sentence.
  const failedFile = files.find((f) => f.status === 'failed' && (f.assertionResults?.length ?? 0) === 0);
  const loadMessage = unknownShape
    ? 'the runner produced a report with no `testResults` array: this parser reads the jest-compatible JSON report, so a --runner-cmd must emit that shape (vitest --reporter=json, jest --json)'
    : loadFailed ? (firstInformativeLine(files.find((f) => f.message)?.message ?? '') || `a test file failed to load and the runner gave no message: ${failedFile?.name ?? 'unknown file'}`)
      : outcome === 'error' ? 'the runner collected no tests: an empty selection, a filter or project that matched nothing, or a test file the runner does not read' : undefined;
  return { run, timeouts, loadMessage, failedTests };
}

/**
 * Run a test process on `files` inside `projectDir` with a hard wall-clock
 * budget and read back its jest-compatible JSON report. The budget matters
 * because a synchronous infinite loop is immune to any runner's own test
 * timeout; only killing the process ends it. `argv(files, outFile)` is the
 * runner's command line; `command` (tests) or `commandTemplate` (--runner-cmd)
 * override it.
 */
export function runProcess({ projectDir, files, budgetMs = 120_000, command, commandTemplate, argv, env = {}, parse = parseReport, cleanupOnClose = false }) {
  assertNotCancelled();
  const outFile = join(scratchRoot(), `testguard-run-${randomBytes(6).toString('hex')}.json`);
  const [cmd, ...args] = command
    ?? (commandTemplate ? expandCommand(commandTemplate, files, outFile) : argv(files, outFile));
  // A runner that names its report through the environment (Playwright) gets `{out}` substituted there too.
  const extraEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll('{out}', outFile)]));
  const started = Date.now();
  const scope = childScope();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...scope.env, ...workerEnv(), ...extraEnv } });
    child.once('close', scope.dispose);
    registerChild(child, () => terminateProcessTree(child));
    child.stdout.resume(); // Reports are read from the file; drain logs to prevent pipe backpressure.
    let stderr = '';
    // Node prints MODULE_TYPELESS_PACKAGE_JSON (and friends) for the PROBED
    // project's config, not for anything the fault did. Keep it out of the
    // stream and out of `loadMessage`, which names the cause of a load error.
    child.stderr.on('data', (d) => (stderr = (stderr + String(d).split('\n').filter((l) => !NODE_NOISE.test(l)).join('\n')).slice(-65536)));
    child.on('error', (e) => (stderr += e.message));
    let killed = false;
    let exit = '';
    const timer = setTimeout(() => {
      killed = true;
      terminateProcessTree(child);
    }, budgetMs);

    child.on('close', (code, signal) => {
      exit = signal ? `signal ${signal}` : `code ${code}`;
      clearTimeout(timer);
      if (cleanupOnClose) terminateProcessTree(child);
      const durationMs = Date.now() - started;
      let result;
      if (killed) {
        result = { run: { outcome: 'timeout', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs }, timeouts: 1, loadMessage: `budget of ${budgetMs}ms exceeded; ${TIMEOUT_CLEANUP_WARNING}`, failedTests: [] };
      } else if (!existsSync(outFile)) {
        result = { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs }, timeouts: 0, loadMessage: stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `runner produced no report (exited with ${exit})`, failedTests: [] };
      } else {
        try {
          result = parse(readBoundedJsonFile(outFile), durationMs);
        } catch (e) {
          result = { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, exceptionFailures: 0, durationMs }, timeouts: 0, loadMessage: `unreadable report: ${e.message}`, failedTests: [] };
        }
      }
      rmSync(outFile, { force: true });
      // The net under every parser: an `error` run that arrived without words gets the runner's last stderr line, else its exit status.
      if (result.run.outcome === 'error' && !String(result.loadMessage ?? '').trim()) {
        result.loadMessage = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `the runner reported an error without a message (exited with ${exit})`;
      }
      resolve(result);
    });
  });
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
  const kindNotReported = runs.reduce((n, r) => n + (r.kindNotReported ?? 0), 0);
  return {
    run: { outcome, tests: { total: sum('total'), passed: sum('passed'), failed: sum('failed') }, assertionFailures: runs.reduce((n, r) => n + r.assertionFailures, 0), exceptionFailures: runs.reduce((n, r) => n + (r.exceptionFailures ?? 0), 0), ...(kindNotReported ? { kindNotReported } : {}), durationMs: runs.reduce((n, r) => n + r.durationMs, 0) },
    timeouts: parts.reduce((n, p) => n + (p.timeouts ?? 0), 0),
    loadMessage: parts.find((p) => p.run.outcome === 'error' && String(p.loadMessage ?? '').trim())?.loadMessage
      ?? (outcome === 'error' ? 'a runner reported an error without a message' : parts.find((p) => p.loadMessage)?.loadMessage),
    failedTests: parts.flatMap((p) => p.failedTests ?? []),
    provenance,
  };
}
