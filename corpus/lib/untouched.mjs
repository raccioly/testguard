/**
 * The subject is the user's project: TestGuard measures it and must leave it
 * as it found it (#279: an install whose links were rewritten; a field report
 * of a tracked test file overwritten after a refused probe). Every probe the
 * harness runs is bracketed by a snapshot of the repository it points at:
 *
 *  - `git status --porcelain --ignored` (untracked and ignored files appear,
 *    so a file the tool drops anywhere in the tree is seen);
 *  - a content hash of every tracked file;
 *  - the entry names and link targets of every `node_modules` level (the
 *    root, scopes, `.bin`, each workspace package's own), never descending
 *    through a link or into a package.
 *
 * A difference is a critical failure, whatever the probe's exit code. Runner
 * caches vite and vitest write into a real node_modules directory on their
 * own (.vite, .vite-temp, .vitest-cache) are not the tool's doing and are
 * left out; nothing else is.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER_CACHES = new Set(['.vite', '.vite-temp', '.vitest-cache']);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function nodeModulesLevels(repo) {
  const out = {};
  const level = (rel) => {
    const abs = join(repo, rel);
    for (const name of readdirSync(abs).sort()) {
      if (rel.split('/').length === 1 && RUNNER_CACHES.has(name)) continue;
      const r = `${rel}/${name}`;
      const st = lstatSync(join(repo, r));
      if (st.isSymbolicLink()) out[r] = `-> ${readlinkSync(join(repo, r))}`;
      else if (st.isDirectory()) {
        out[r] = 'dir';
        // Scopes and .bin are levels a package manager writes; a package is a leaf.
        if (name.startsWith('@') || name === '.bin' || name === '.pnpm') level(r);
      } else out[r] = `file ${createHash('sha256').update(readFileSync(join(repo, r))).digest('hex').slice(0, 16)}`;
    }
  };
  const roots = ['node_modules', ...git(repo, 'ls-files', '-z').split('\0').filter((f) => f.endsWith('/package.json')).map((f) => `${f.slice(0, -'/package.json'.length)}/node_modules`)];
  for (const rel of roots) {
    const abs = join(repo, rel);
    if (!existsSync(abs) && !isLink(abs)) continue;
    if (isLink(abs)) { out[rel] = `-> ${readlinkSync(abs)}`; continue; }
    out[rel] = 'dir';
    level(rel);
  }
  return out;
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function snapshotSubject(repo) {
  const status = git(repo, 'status', '--porcelain', '--ignored', '--untracked-files=all')
    .split('\n').filter(Boolean).filter((l) => !/^!! (.*\/)?node_modules\//.test(l));
  const tracked = {};
  for (const f of git(repo, 'ls-files', '-z').split('\0').filter(Boolean)) {
    const p = join(repo, f);
    tracked[f] = isLink(p) ? `-> ${readlinkSync(p)}` : existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing';
  }
  return { status, tracked, nodeModules: nodeModulesLevels(repo) };
}

/** Paths that differ between two snapshots, each with what changed. */
export function compareSnapshots(before, after) {
  const changes = [];
  const diffMaps = (kind, a, b) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] !== b[k]) changes.push({ path: k, kind, before: a[k] ?? null, after: b[k] ?? null });
    }
  };
  diffMaps('tracked', before.tracked, after.tracked);
  diffMaps('node_modules', before.nodeModules, after.nodeModules);
  const sa = new Set(before.status);
  const sb = new Set(after.status);
  for (const l of sb) if (!sa.has(l)) changes.push({ path: l.slice(3), kind: 'status', before: null, after: l.slice(0, 2) });
  for (const l of sa) if (!sb.has(l)) changes.push({ path: l.slice(3), kind: 'status', before: l.slice(0, 2), after: null });
  return changes;
}

export const snapshotIsEmpty = (s) => Object.keys(s.tracked).length === 0;
