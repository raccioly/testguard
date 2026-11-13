import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { ownersDir } from './owner.mjs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { gitCommonDir, pruneWorktrees } from '../git.mjs';
import { defaultAlive } from '../probe/contention.mjs';
import { lockIsStale, parseLock, LOCK_NAME, withWorktreeLock, worktreeLockDir } from '../probe/worktree-lock.mjs';
import { workerSlotDir } from '../probe/worker-env.mjs';

/**
 * Scratch trees an interrupted probe leaves behind, and the way to remove them (#311).
 *
 * Every scratch tree and child scope a command creates carries an OWNER
 * RECORD — the creating process's pid and host — in `testguard-locks/owners/<name>.json` under
 * the scratch root. It is a sibling record, never a file inside the tree: a
 * file in the tree would be one more untracked file for the project's own
 * tests to trip over. A tree is an ORPHAN when its owner is provably gone
 * (the same host and a pid that no longer runs, the rule the worktree lock
 * already uses), or — no record at all, a tree from before records existed —
 * when it is older than ORPHAN_AGE_MS. A live owner, another host's owner and
 * a young ownerless tree are never touched.
 *
 * Names are matched against the exact shapes this tool creates
 * (`mkdtemp` + six characters), never a bare `testguard-*`: a directory a
 * user or another tool happened to name that way is not ours to delete.
 */

export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** What a command spends on cleanup before its own work starts; the rest waits for the next run. */
export const START_BUDGET_MS = 3000;
/** What `status` spends looking, so a session-start hook stays quick. */
export const STATUS_BUDGET_MS = 250;

// What this tool creates under the scratch root: `mkdtemp` directories (scratch worktrees, child scopes, type-check and node-runner
// directories) and single files named with random hex (the temporary git index and the runners' report, list and sidecar files).
const TREE_NAME = /^testguard-(?:(?:child|tc|node)-)?[A-Za-z0-9]{6}$/;
const FILE_NAME = /^testguard-(?:index-[0-9a-f]{12}|(?:run|discovery|vitest-list|vitest-kinds|playwright-kinds)-[0-9a-f]{12,16}\.json)$/;

const readOwner = (file) => { try { const owner = parseLock(readFileSync(file, 'utf8')); return owner && typeof owner === 'object' ? owner : null; } catch { return null; } };

/**
 * Every orphan under `base`, bounded by `deadline` (a `Date.now()` value;
 * `capped` says it ran out). Nothing is removed. Each entry:
 * `{ kind, path, reason, owner? }` with kind `scratch-tree`, `scratch-file`,
 * `stale-lock` or `owner-record`.
 */
export function scanOrphans(base, { alive = defaultAlive, host = hostname(), now = Date.now, ageMs = ORPHAN_AGE_MS, deadline = Infinity } = {}) {
  const orphans = [];
  let capped = false;
  const over = () => now() > deadline;
  let entries = [];
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return { orphans, capped }; }
  const present = new Set(entries.map((e) => e.name));
  const old = (path) => { try { return now() - lstatSync(path).mtimeMs > ageMs; } catch { return false; } };
  for (const entry of entries) {
    if (over()) { capped = true; break; }
    const isTree = entry.isDirectory() && TREE_NAME.test(entry.name);
    const isFile = !entry.isDirectory() && FILE_NAME.test(entry.name);
    if (!isTree && !isFile) continue;
    const path = join(base, entry.name);
    const owner = isTree ? readOwner(join(ownersDir(base), `${entry.name}.json`)) : null;
    if (owner) {
      if (lockIsStale(owner, { alive, host })) orphans.push({ kind: 'scratch-tree', path, reason: `its owner (pid ${owner.pid}) is gone`, owner });
    } else if (old(path)) {
      orphans.push({ kind: isTree ? 'scratch-tree' : 'scratch-file', path, reason: 'no owner record and older than 24 hours' });
    }
  }
  // Owner records whose tree is gone: a record is only useful beside its tree.
  try {
    for (const name of readdirSync(ownersDir(base))) {
      if (over()) { capped = true; break; }
      if (!name.endsWith('.json') || present.has(name.slice(0, -5))) continue;
      const path = join(ownersDir(base), name);
      const owner = readOwner(path);
      if (!owner || lockIsStale(owner, { alive, host })) orphans.push({ kind: 'owner-record', path, reason: 'its tree is gone' });
    }
  } catch { /* no owners directory yet */ }
  // Lock files whose owner is gone: the worktree lock of each repository and the worker slots.
  const locks = [];
  const lockRoot = join(base, 'testguard-locks');
  try {
    for (const dir of readdirSync(lockRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === 'owners') continue;
      if (dir.name === 'worker-slots') {
        for (const f of readdirSync(workerSlotDir(base))) if (/^slot-\d+\.lock$/.test(f)) locks.push(join(workerSlotDir(base), f));
      } else {
        locks.push(join(lockRoot, dir.name, LOCK_NAME));
      }
    }
  } catch { /* no locks directory yet */ }
  for (const path of locks) {
    if (over()) { capped = true; break; }
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const owner = parseLock(text);
    if (lockIsStale(owner, { alive, host })) orphans.push({ kind: 'stale-lock', path, reason: `its owner (pid ${owner.pid}) is gone` });
  }
  return { orphans, capped };
}

/** Disk bytes under `path` (lstat blocks, never following links); 0 for what cannot be read. */
export function diskBytes(path) {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = lstatSync(p); } catch { continue; }
    total += (st.blocks ?? 0) * 512;
    if (st.isDirectory()) { try { for (const name of readdirSync(p)) stack.push(join(p, name)); } catch { /* unreadable */ } }
  }
  return total;
}

/**
 * Report and (unless `dryRun`) remove the orphans under `base`, then prune the
 * worktree registrations of this repository (`repoRoot`) — never another
 * repository's: that would write outside what the command was pointed at.
 * `budgetMs` bounds the whole run:
 * what it did not reach is left for the next one and `capped` says so.
 * Never throws for a path it cannot remove: that entry is reported as `failed`.
 */
export function cleanOrphans({ base, repoRoot, dryRun = false, measure = false, budgetMs = Infinity, alive, host, now = Date.now, ageMs, rm = rmSync, lockWaitMs = 2000 } = {}) {
  const deadline = Number.isFinite(budgetMs) ? now() + budgetMs : Infinity;
  const { orphans, capped: scanCapped } = scanOrphans(base, { alive, host, now, ageMs, deadline });
  const removed = [];
  const failed = [];
  let capped = scanCapped;
  for (const orphan of orphans) {
    if (now() > deadline) { capped = true; break; }
    const bytes = measure ? diskBytes(orphan.path) : undefined;
    if (!dryRun) {
      try {
        rm(orphan.path, { recursive: true, force: true });
        if (orphan.kind === 'scratch-tree') rmSync(join(ownersDir(base), `${basename(orphan.path)}.json`), { force: true });
      } catch (error) { failed.push({ kind: orphan.kind, path: orphan.path, error: error.code ?? error.message }); continue; }
    }
    removed.push({ kind: orphan.kind, path: orphan.path, reason: orphan.reason, ...(bytes === undefined ? {} : { bytes }) });
  }
  const worktrees = [];
  let repo;
  try { repo = repoRoot ? gitCommonDir(repoRoot) : undefined; } catch { repo = undefined; /* not a repository: nothing to prune */ }
  if (repo && now() <= deadline) {
    try {
      const lines = dryRun ? pruneWorktrees(repo, { dryRun: true }) : withWorktreeLock(worktreeLockDir(repo, base), () => pruneWorktrees(repo), { timeoutMs: lockWaitMs, ...(alive ? { alive } : {}) });
      for (const line of lines) worktrees.push({ registration: line.replace(/^Removing /, '') });
    } catch { /* a lock held by a live probe: leave it for the next run */ }
  }
  return { base, dryRun, capped, removed, failed, worktrees, bytes: removed.reduce((n, r) => n + (r.bytes ?? 0), 0) };
}

/**
 * The cleanup a command does before its own work: bounded, quiet when there
 * is nothing to do, one warning line when something went wrong, never a
 * failure. Returns the report, or null when it could not run.
 */
export function cleanOnStart({ base, repoRoot, warn = () => {}, budgetMs = START_BUDGET_MS, ...options }) {
  try {
    const report = cleanOrphans({ base, repoRoot, budgetMs, ...options });
    if (report.failed.length) warn(`warning: could not remove ${report.failed.length} orphaned scratch ${report.failed.length === 1 ? 'entry' : 'entries'} under ${base} (testguard clean reports them)`);
    return report;
  } catch (error) {
    warn(`warning: orphaned scratch cleanup skipped: ${error.message}`);
    return null;
  }
}
