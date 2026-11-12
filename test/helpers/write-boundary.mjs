import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Preloaded into every Node process of a run: records, then refuses, any network use. */
export const NETWORK_GUARD = fileURLToPath(new URL('./no-network-guard.mjs', import.meta.url));

/**
 * Every entry under `dir` as `relative path -> kind:size:mtime`, symlinks not
 * followed. The before/after listings the write-boundary acceptance tests
 * diff. A listing that finds nothing proves nothing, so callers assert it is
 * non-empty before they compare.
 */
export function listing(dir, skip = () => false) {
  const out = new Map();
  const visit = (path) => {
    const rel = relative(dir, path) || '.';
    if (skip(rel)) return;
    let st;
    try { st = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } // gone between readdir and lstat
    out.set(rel, `${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'}:${st.isDirectory() ? 0 : st.size}:${st.isDirectory() ? 0 : st.mtimeMs}`);
    if (st.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(dir);
  return out;
}

/** What changed between two listings: created, removed and modified paths. */
export function changes(before, after) {
  const created = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const modified = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  return { created, removed, modified };
}

/**
 * `cp -R`, never a symlink: a chmod on the copy must not reach the original.
 * Symlinks inside (`.bin`) stay symlinks, but a SOURCE that is itself a link
 * (a node_modules linked into a git worktree) is followed: `cp -R` of a link
 * copies the link, and the "copy" then has no packages in it.
 */
export function copyTree(from, to) {
  const r = spawnSync('cp', ['-R', realpathSync(from), to], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cp -R ${from} ${to}: ${r.stderr}`);
}

/** `chmod -R a-w` ('ro') or `chmod -R u+w` ('rw'): write bits only, so executables stay executable. Children are visited before a directory is locked. */
export function chmodTree(dir, mode) {
  const visit = (path) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(path, st.mode | 0o200); // readable to traverse
      for (const name of readdirSync(path)) visit(join(path, name));
    }
    const bits = st.mode & 0o7777;
    chmodSync(path, mode === 'ro' ? bits & ~0o222 : bits | 0o200);
  };
  visit(dir);
}

export const makeDir = (path) => { mkdirSync(path, { recursive: true }); return path; };
