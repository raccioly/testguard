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
      : run('ps', ['-Ao', 'pid=,ppid=,stat=,args='], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout.split('\n').map((line) => {
      if (platform !== 'win32') {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (row) return { pid: Number(row[1]), ppid: Number(row[2]), stat: row[3], command: row[4].trim() };
      }
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
  const owned = new Set([self]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
  }
  const ancestors = new Set();
  let parent = rows.find((row) => row.pid === self)?.ppid;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = rows.find((row) => row.pid === parent)?.ppid;
  }
  const runners = rows
    .filter((p) => !owned.has(p.pid) && !ancestors.has(p.pid) && !p.stat?.startsWith('Z') && RUNNER_RE.test(p.command) && (p.ppid !== undefined || !SELF_RE.test(p.command)))
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

/**
 * What would actually change this run. `--serial` is the same as `--workers 1`,
 * which is the default, so advising it to a run that is already serial offers
 * a flag that changes nothing; a custom command's concurrency is its own.
 */
function contentionAdvice({ serial = true, workers = 1, custom = false }) {
  if (custom) return 'Wait for it to finish; a --runner-cmd manages its own concurrency, so make that command run one test file at a time if it does not already.';
  if (serial || workers <= 1) return 'Wait for it to finish: this probe already runs one test file at a time (--workers 1), so --serial would change nothing.';
  return `Wait for it to finish, or lower --workers ${workers} (or pass --serial) to run one test file at a time.`;
}

/** One line for the operator: what is running, what it costs, and what would help. */
export const contentionWarning = (c, policy = {}) =>
  `${c.runners.length} test runner${c.runners.length === 1 ? ' is' : 's are'} already running (${c.runners.map((r) => `pid ${r.pid}`).join(', ')}); ` +
  'defenders run N times each here, and a suite that times out under parallel load yields TIMEOUT or FLAKY-DEFENDER — verdicts about the load, not the claim. ' +
  contentionAdvice(policy);
