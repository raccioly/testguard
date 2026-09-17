import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { matchGlobs } from '../util/glob.mjs';

const TEST_GLOBS = ['**/*.test.js', '**/*.test.mjs', '**/*.test.cjs', '**/*.test.ts', '**/*.test.mts', '**/*.test.tsx', '**/*.test.jsx',
  '**/*.spec.js', '**/*.spec.mjs', '**/*.spec.cjs', '**/*.spec.ts', '**/*.spec.mts', '**/*.spec.tsx', '**/*.spec.jsx'];

export const name = 'vitest';

/** Defender globs → existing files. Empty result is the `nocover` signal. */
export const resolveDefenders = (projectDir, globs) => matchGlobs(projectDir, globs ?? []);

export const listTestFiles = (projectDir) => matchGlobs(projectDir, TEST_GLOBS);

/**
 * Turn vitest's JSON report into a spec `testRun`.
 *
 * `assertionFailures` counts test-level failures that are neither timeouts nor
 * load failures — the test body ran and rejected the behaviour. Only those
 * can kill a fault. A suite that fails to load, or a test that times out, is
 * not evidence that the suite defends the claim.
 */
export function parseReport(report, durationMs) {
  const files = report.testResults ?? [];
  const loadFailed = files.some((f) => f.status === 'failed' && (f.assertionResults?.length ?? 0) === 0);
  const results = files.flatMap((f) => (f.assertionResults ?? []).map((t) => ({ ...t, id: `${f.name}::${t.fullName ?? t.title ?? ''}` }))).filter((t) => t.status === 'failed');
  const timeouts = results.filter((t) => (t.failureMessages ?? []).some((m) => /timed out/i.test(m))).length;
  const failedTests = results.map((t) => t.id);
  const assertionFailures = results.length - timeouts;
  const tests = { total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0 };

  let outcome;
  if (loadFailed || tests.total === 0) outcome = 'error';
  else if (report.success) outcome = 'pass';
  else outcome = 'fail';

  const run = { outcome, tests, assertionFailures, durationMs };
  const loadMessage = loadFailed ? (files.find((f) => f.message)?.message ?? '').split('\n')[0] : undefined;
  return { run, timeouts, loadMessage, failedTests };
}

/**
 * Run vitest on `files` inside `projectDir` with a hard wall-clock budget.
 * The budget matters because a synchronous infinite loop is immune to
 * vitest's own test timeout; only killing the process ends it.
 */
export function runVitest({ projectDir, files, budgetMs = 120_000, command }) {
  const outFile = join(tmpdir(), `testguard-vitest-${randomBytes(6).toString('hex')}.json`);
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const [cmd, ...args] = command ?? [npx, 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${outFile}`];
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
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
          result = parseReport(JSON.parse(readFileSync(outFile, 'utf8')), durationMs);
        } catch (e) {
          result = { run: { outcome: 'error', tests: { total: 0, passed: 0, failed: 0 }, assertionFailures: 0, durationMs }, timeouts: 0, loadMessage: `unreadable report: ${e.message}`, failedTests: [] };
        }
      }
      rmSync(outFile, { force: true });
      resolve(result);
    });
  });
}
