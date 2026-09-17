import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { matchGlobs } from '../../util/glob.mjs';

export const TEST_GLOBS = ['**/*.test.js', '**/*.test.mjs', '**/*.test.cjs', '**/*.test.ts', '**/*.test.mts', '**/*.test.tsx', '**/*.test.jsx',
  '**/*.spec.js', '**/*.spec.mjs', '**/*.spec.cjs', '**/*.spec.ts', '**/*.spec.mts', '**/*.spec.tsx', '**/*.spec.jsx'];
export const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Node's own advisory warnings about the probed project's configuration; never about the fault. */
export const NODE_NOISE = /MODULE_TYPELESS_PACKAGE_JSON|ExperimentalWarning|--trace-warnings|Reparsing as ES module|To eliminate this warning/;

/**
 * Split a runner command template into argv. Supports double and single
 * quotes; `{files}` expands to the test files (one argv entry each) and
 * `{out}` to the JSON report path. Everything else is passed through.
 */
export function parseCommandTemplate(template) {
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
  if (quote) throw new RangeError('unterminated quote in --runner-cmd');
  if (!words.includes('{files}') || !words.some((w) => w.includes('{out}'))) throw new RangeError('--runner-cmd must contain {files} (as its own word) and {out}');
  return words;
}

/** `{files}` must be a word of its own (one argv entry per file); `{out}` may be embedded, e.g. `--outputFile={out}`. */
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
      child = spawn(process.platform === 'win32' ? `${bin}.cmd` : bin, ['--version'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, CI: '1' } });
    } catch (e) {
      return resolve({ ok: false, message: e.message });
    }
    let out = '';
    let err = '';
    child.on('error', () => resolve({ ok: false, message: `${pkg} is not installed in the project and \`${bin}\` is not on PATH (npm i -D ${pkg})` }));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs);
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
 * `assertionFailures` counts test-level failures that are neither timeouts nor
 * load failures — the test body ran and rejected the behaviour. Only those
 * can kill a fault. A suite that fails to load, or a test that times out, is
 * not evidence that the suite defends the claim.
 */
export function firstInformativeLine(message) {
  const lines = message.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  return lines.find((l) => /error|syntax|unexpected|expected .+ but found|cannot find|failed to parse|transform failed/i.test(l) && !/^●/.test(l)) ?? lines[0] ?? '';
}

export function parseReport(report, durationMs) {
  const files = report.testResults ?? [];
  const loadFailed = files.some((f) => f.status === 'failed' && (f.assertionResults?.length ?? 0) === 0);
  const results = files.flatMap((f) => (f.assertionResults ?? []).map((t) => ({ ...t, id: `${f.name}::${t.fullName ?? t.title ?? ''}` }))).filter((t) => t.status === 'failed');
  const timeouts = results.filter((t) => (t.failureMessages ?? []).some((m) => /timed out|exceeded timeout/i.test(m))).length;
  const failedTests = results.map((t) => t.id);
  const assertionFailures = results.length - timeouts;
  const tests = { total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0 };

  let outcome;
  if (loadFailed || tests.total === 0) outcome = 'error';
  else if (report.success) outcome = 'pass';
  else outcome = 'fail';

  const run = { outcome, tests, assertionFailures, durationMs };
  // jest opens a load failure with "● Test suite failed to run" and puts the
  // cause lines below; vitest puts it on the first line. Take the first line
  // that names an error, else the first non-empty one.
  const loadMessage = loadFailed ? firstInformativeLine(files.find((f) => f.message)?.message ?? '') : undefined;
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
export function runProcess({ projectDir, files, budgetMs = 120_000, command, commandTemplate, argv, env = {}, parse = parseReport }) {
  const outFile = join(tmpdir(), `testguard-run-${randomBytes(6).toString('hex')}.json`);
  const [cmd, ...args] = command
    ?? (commandTemplate ? expandCommand(commandTemplate, files, outFile) : argv(files, outFile));
  // A runner that names its report through the environment (Playwright) gets `{out}` substituted there too.
  const extraEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll('{out}', outFile)]));
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...extraEnv } });
    let stderr = '';
    // Node prints MODULE_TYPELESS_PACKAGE_JSON (and friends) for the PROBED
    // project's config, not for anything the fault did. Keep it out of the
    // stream and out of `loadMessage`, which names the cause of a load error.
    child.stderr.on('data', (d) => (stderr += String(d).split('\n').filter((l) => !NODE_NOISE.test(l)).join('\n')));
    child.on('error', (e) => (stderr += e.message));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, budgetMs);

    child.on('close', () => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      let result;
      if (killed) {
        result = { run: { outcome: 'timeout', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, durationMs }, timeouts: 1, loadMessage: `budget of ${budgetMs}ms exceeded`, failedTests: [] };
      } else if (!existsSync(outFile)) {
        result = { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, durationMs }, timeouts: 0, loadMessage: stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'runner produced no report', failedTests: [] };
      } else {
        try {
          result = parse(JSON.parse(readFileSync(outFile, 'utf8')), durationMs);
        } catch (e) {
          result = { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, durationMs }, timeouts: 0, loadMessage: `unreadable report: ${e.message}`, failedTests: [] };
        }
      }
      rmSync(outFile, { force: true });
      resolve(result);
    });
  });
}
