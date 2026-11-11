import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { scratchRoot } from './scratch-dir.mjs';

export class GitError extends Error {
  /** `timedOut`: git did not finish in time, which is not the same finding as git refusing. */
  constructor(message, { timedOut = false } = {}) {
    super(message);
    this.kind = 'git';
    this.timedOut = timedOut;
  }
}

export function gitRaw(args, cwd, env, { timeoutMs = 30_000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env } });
  if (r.status !== 0) {
    const timedOut = r.error?.code === 'ETIMEDOUT';
    throw new GitError(`git ${args.join(' ')}: ${timedOut ? `timed out after ${timeoutMs} ms` : (r.stderr || r.stdout || r.error?.message || '').trim()}`, { timedOut });
  }
  return r.stdout;
}

export const git = (args, cwd, env, options) => gitRaw(args, cwd, env, options).trim();

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
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, ref], { cwd: dir, timeout: 30_000 }).status === 0;
}

/** True when any of `paths` (repo-relative; empty = whole tree) has uncommitted changes. */
export const isDirty = (dir, paths = []) => git(['status', '--porcelain', '--', ...paths], dir).length > 0;

/**
 * Leading options for a git command that checks files out into TestGuard's own
 * scratch tree. That tree is the instrument, not a checkout the user made, so
 * their post-checkout hook (husky, lefthook, Git LFS) must not run on it: a
 * failing one fails the whole command after the files are already written, and
 * Git LFS's fails whenever git-lfs is not on PATH. Filters, LFS smudge
 * included, are config, not hooks, and still apply. An fsmonitor daemon is
 * not started for a tree that lives for minutes and is then deleted (#237).
 */
export const NO_HOOKS = Object.freeze(['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false']);

/**
 * The environment for a git call that creates, removes or prunes a scratch
 * tree. Inherited `GIT_*` variables are stripped: run from a pre-commit hook,
 * `GIT_INDEX_FILE`, `GIT_DIR` or `GIT_WORK_TREE` would point the call at the
 * user's index or tree instead of the scratch one. Prompts are disabled — no
 * scratch-tree operation may ever wait on a terminal — and so are git's
 * optional locks, so a scratch call never refreshes the user's index. Exported for tests.
 */
export function scratchGitEnv(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

function scratchGit(args, cwd) {
  return spawnSync('git', [...NO_HOOKS, ...args], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: scratchGitEnv() });
}

/**
 * The git common directory of `repo` (shared by its linked worktrees), as a
 * real path: two processes that reach one repository through different
 * spellings (/var vs /private/var on macOS) must agree on one lock file.
 */
export function gitCommonDir(repo) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: scratchGitEnv() });
  if (r.status !== 0) throw new GitError(`git rev-parse --git-common-dir: ${(r.stderr || r.stdout).trim()}`);
  return realpathSync(resolve(repo, r.stdout.trim()));
}

export function addWorktree(repo, dest, ref = 'HEAD') {
  const r = scratchGit(['worktree', 'add', '--detach', dest, ref], repo);
  if (r.status !== 0) throw new GitError(`git worktree add --detach ${dest} ${ref}: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

/**
 * A dangling commit holding the working tree exactly as it is — tracked
 * changes AND untracked (non-ignored) files — without touching HEAD, the
 * index, or any ref. Built through a temporary index so the user's staging
 * area is never read or written.
 */
export function snapshotWorkingTree(repo) {
  const index = join(scratchRoot(), `testguard-index-${randomBytes(6).toString('hex')}`);
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
  scratchGit(['worktree', 'remove', '--force', dest], repo);
  rmSync(dest, { recursive: true, force: true });
  scratchGit(['worktree', 'prune'], repo);
}
