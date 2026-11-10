import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultAlive } from './contention.mjs';

/**
 * One lock around scratch-worktree allocation and removal (issue #237).
 *
 * `git worktree add` and `git worktree prune` both rewrite the repository's
 * shared worktree registry under the git common directory. Two `probe`
 * commands on one repository — two agents, or one agent and CI on a dev box —
 * could otherwise interleave an add with a prune and lose or corrupt each
 * other's scratch trees. The lock lives in the git COMMON directory, so linked
 * worktrees of the same repository share it.
 *
 * Held only around the synchronous git calls, never across an await, and so
 * never for longer than a checkout.
 */

export const LOCK_NAME = 'testguard-worktrees.lock';

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
 * Take the lock, run `fn`, release. Synchronous by design (see above).
 * Waits up to `timeoutMs` for a live owner, then fails loudly rather than
 * proceeding unlocked.
 */
export function withWorktreeLock(gitCommonDir, fn, { timeoutMs = 120_000, alive = defaultAlive, now = Date.now, pause = sleep } = {}) {
  const path = join(gitCommonDir, LOCK_NAME);
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
