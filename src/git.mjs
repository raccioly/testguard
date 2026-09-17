import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class GitError extends Error {}

export function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) throw new GitError(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export const repoRoot = (dir) => git(['rev-parse', '--show-toplevel'], dir);

/** Full sha of `ref` (default HEAD), or null when it does not resolve. */
export function headSha(dir, ref = 'HEAD') {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`], dir);
  } catch {
    return null;
  }
}

/** Is `ancestor` reachable from `ref`? False when either does not resolve. */
export function isAncestor(dir, ancestor, ref = 'HEAD') {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, ref], { cwd: dir }).status === 0;
}

/** True when any of `paths` (repo-relative; empty = whole tree) has uncommitted changes. */
export const isDirty = (dir, paths = []) => git(['status', '--porcelain', '--', ...paths], dir).length > 0;

export const addWorktree = (repo, dest, ref = 'HEAD') => git(['worktree', 'add', '--detach', dest, ref], repo);

/**
 * A dangling commit holding the working tree exactly as it is — tracked
 * changes AND untracked (non-ignored) files — without touching HEAD, the
 * index, or any ref. Built through a temporary index so the user's staging
 * area is never read or written.
 */
export function snapshotWorkingTree(repo) {
  const index = join(tmpdir(), `testguard-index-${randomBytes(6).toString('hex')}`);
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'testguard', GIT_AUTHOR_EMAIL: 'testguard@localhost',
    GIT_COMMITTER_NAME: 'testguard', GIT_COMMITTER_EMAIL: 'testguard@localhost',
  };
  try {
    git(['read-tree', 'HEAD'], repo, env);
    git(['add', '-A', '--', '.'], repo, env);
    const tree = git(['write-tree'], repo, env);
    return git(['commit-tree', tree, '-p', 'HEAD', '-m', 'testguard: working-tree snapshot (not a ref)'], repo, env);
  } finally {
    rmSync(index, { force: true });
  }
}

export function removeWorktree(repo, dest) {
  spawnSync('git', ['worktree', 'remove', '--force', dest], { cwd: repo });
  rmSync(dest, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: repo });
}
