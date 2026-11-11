import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultAlive } from './contention.mjs';

/**
 * One lock around scratch-worktree allocation and removal (issue #237).
 *
 * `git worktree add` and `git worktree prune` both rewrite the repository's
 * shared worktree registry under the git common directory. Two `probe`
 * commands on one repository — two agents, or one agent and CI on a dev box —
 * could otherwise interleave an add with a prune and lose or corrupt each
 * other's scratch trees. The lock is keyed by the git COMMON directory, so
 * linked worktrees of the same repository share it, and it lives under
 * TestGuard's scratch root, never inside the repository: a file in the git
 * directory is a write outside the boundary a confined caller grants, and
 * `git worktree prune` deletes anything it does not recognize under
 * `.git/worktrees`. Probes that name different scratch directories therefore
 * do not coordinate; git's own `locked` marker during `worktree add` still
 * keeps a prune from removing a tree being created.
 *
 * Held only around the synchronous git calls, never across an await, and so
 * never for longer than a checkout.
 */

export const LOCK_NAME = 'testguard-worktrees.lock';

/** The directory holding the lock for one repository (its git common directory), under `base`. */
export function worktreeLockDir(gitCommonDir, base = tmpdir()) {
  const dir = join(base, 'testguard-locks', createHash('sha256').update(gitCommonDir).digest('hex').slice(0, 24));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What a lock file says about its owner, or null when it cannot be read. */
export function parseLock(text) {
  try {
    const owner = JSON.parse(text);
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

/**
 * May this lock be taken over? Only when its owner is provably gone: the same
 * host and a pid that no longer runs. A lock written on another host (a shared
 * network checkout) cannot be judged by our process table, and an unreadable
 * one may be a write still in progress — both are waited on, never broken.
 */
export function lockIsStale(owner, { alive = defaultAlive, host = hostname() } = {}) {
  if (!owner) return false;
  if (owner.host && owner.host !== host) return false;
  return !alive(owner.pid);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Take the lock in `lockDir` (from `worktreeLockDir`), run `fn`, release. Synchronous by design (see above).
 * Waits up to `timeoutMs` for a live owner, then fails loudly rather than
 * proceeding unlocked.
 */
export function withWorktreeLock(lockDir, fn, { timeoutMs = 120_000, alive = defaultAlive, now = Date.now, pause = sleep } = {}) {
  const path = join(lockDir, LOCK_NAME);
  const deadline = now() + timeoutMs;
  let delay = 10;
  for (;;) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        rmSync(path, { force: true });
      }
    }
    let owner = null;
    try { owner = parseLock(readFileSync(path, 'utf8')); } catch { /* vanished: retry at once */ continue; }
    if (lockIsStale(owner, { alive })) {
      rmSync(path, { force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new Error(`another TestGuard process (pid ${owner?.pid ?? 'unknown'}) has held ${path} for over ${Math.round(timeoutMs / 1000)}s; if no probe is running, delete that file`);
    }
    pause(delay);
    delay = Math.min(delay * 2, 250);
  }
}
