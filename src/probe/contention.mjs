import { spawnSync } from 'node:child_process';

/**
 * Concurrent test runners (issue #26).
 *
 * A probe runs the defenders 3× clean and 3× with each fault applied. Heavy
 * suites time out under parallel CPU load, and a timeout is a verdict —
 * `TIMEOUT` or `FLAKY-DEFENDER` — that says nothing about the claim. A field
 * report serialised everything by hand for exactly this reason. We cannot
 * prevent the contention, but we can name it: warn before the first run, and
 * record it on the evidence so a later reader of a flaky verdict knows the
 * run was contended.
 *
 * Best effort by design: the detector never fails a probe, and a process list
 * it cannot read is simply no detection.
 */

const RUNNER_RE = /\b(vitest|jest|playwright|mocha|ava|karma|cypress)\b/i;
// Our own child processes and this process are not contention.
const SELF_RE = /testguard/i;

/**
 * Is this pid still running? Signal 0 checks for the process without touching
 * it: ESRCH means gone, EPERM means alive but not ours. Injectable for tests.
 */
export function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** Rows of the process table as `{ pid, command }`, or [] when it cannot be read. */
export function processList({ platform = process.platform, run = spawnSync } = {}) {
  try {
    const r = platform === 'win32'
      ? run('wmic', ['process', 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8', timeout: 5000 })
      : run('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout.split('\n').map((line) => {
      const m = platform === 'win32' ? /^[^,]*,(.*),(\d+)\s*$/.exec(line) : /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) return null;
      const [pid, command] = platform === 'win32' ? [m[2], m[1]] : [m[1], m[2]];
      return { pid: Number(pid), command: command.trim() };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Test runners already running, other than ours. Returns
 * `{ detected, runners: [{ pid, command }] }`; `detected` is false when
 * nothing was found or the process list could not be read.
 */
export function detectContention({ self = process.pid, alive = defaultAlive, ...opts } = {}) {
  const rows = processList(opts);
  const runners = rows
    .filter((p) => p.pid !== self && RUNNER_RE.test(p.command) && !SELF_RE.test(p.command))
    // `ps` lists the grep/ps itself and any shell wrapper; a runner's command
    // line always names its own binary, so require it to look like an exec.
    .filter((p) => !/^\s*(ps|grep|wmic)\b/.test(p.command))
    // The process list is a snapshot, and a suite that finished between `ps`
    // and this line would be reported as contention that no longer exists — a
    // warning the operator cannot act on and cannot verify, since the pid is
    // already gone by the time they look. Re-check liveness immediately before
    // reporting. A pid we may not signal is still running, so EPERM is alive.
    .filter((p) => alive(p.pid))
    .map((p) => ({ pid: p.pid, command: p.command.length > 200 ? p.command.slice(0, 197) + '…' : p.command }));
  return { detected: runners.length > 0, runners };
}

/** One line for the operator: what is running, and what it costs. */
export const contentionWarning = (c) =>
  `${c.runners.length} test runner${c.runners.length === 1 ? ' is' : 's are'} already running (${c.runners.map((r) => `pid ${r.pid}`).join(', ')}); ` +
  'defenders run N times each here, and a suite that times out under parallel load yields TIMEOUT or FLAKY-DEFENDER — verdicts about the load, not the claim. ' +
  'Wait for it to finish, or pass --serial to run one test file at a time.';
