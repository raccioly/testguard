import { spawnSync } from 'node:child_process';

/** The only signal a teardown sends: a child that ignores SIGTERM changes nothing. */
export const KILL = 'SIGKILL';

/**
 * The process table, or `null` when `ps` could not be read in time. Never an
 * empty list for a failure: under heavy load `ps` can exceed its timeout, and
 * an unread table is an unverified teardown, not a tree with no descendants.
 */
export function processRows({ timeoutMs = 3000, run = spawnSync } = {}) {
  if (process.platform === 'win32') return null;
  const result = run('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const rows = [];
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid, pgid, stat = ''] = line.trim().split(/\s+/);
    if (Number.isInteger(Number(pid)) && Number.isInteger(Number(ppid)) && Number.isInteger(Number(pgid)) && pid) rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat });
  }
  return rows;
}

export function descendantPids(rows, rootPid) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const visit = (pid) => { for (const child of children.get(pid) ?? []) { if (seen.has(child)) continue; seen.add(child); visit(child); out.push(child); } };
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
 *
 * Everything is SIGKILL: there is no graceful phase, so a child that ignores
 * SIGTERM changes nothing. Returns what it signaled and whether the process
 * table could be read; a table that could not be read in `listMs` is retried
 * while the group is frozen (nothing can fork or reparent), then reported as
 * `listed: false` rather than treated as an empty tree.
 */
export function terminateProcessTree(child, { list = processRows, listMs = 3000 } = {}) {
  const signaled = { pids: [], listed: true };
  if (!child.pid) return signaled;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 1000 });
    try { child.kill('SIGKILL'); } catch {}
    return signaled;
  }
  // Freeze the main group before enumerating so it cannot fork between the
  // snapshot and the kill. A deliberately detached descendant is outside the
  // group but remains visible through PPID and is killed explicitly.
  try { process.kill(-child.pid, 'SIGSTOP'); } catch {}
  const until = Date.now() + listMs;
  let rows = null;
  do { rows = list({ timeoutMs: Math.max(200, until - Date.now()) }); } while (rows === null && Date.now() < until);
  signaled.listed = rows !== null;
  for (const pid of descendantPids(rows ?? [], child.pid)) {
    signaled.pids.push(pid);
    try { process.kill(pid, KILL); } catch {}
  }
  try { process.kill(-child.pid, KILL); } catch {}
  try { child.kill(KILL); } catch {}
  return signaled;
}
