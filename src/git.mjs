import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export class GitError extends Error {}

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
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

/** True when any of `paths` (repo-relative; empty = whole tree) has uncommitted changes. */
export const isDirty = (dir, paths = []) => git(['status', '--porcelain', '--', ...paths], dir).length > 0;

export const addWorktree = (repo, dest, ref = 'HEAD') => git(['worktree', 'add', '--detach', dest, ref], repo);

export function removeWorktree(repo, dest) {
  spawnSync('git', ['worktree', 'remove', '--force', dest], { cwd: repo });
  rmSync(dest, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: repo });
}
