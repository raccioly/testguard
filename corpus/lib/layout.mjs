/**
 * How a subject's files and dependencies are laid out in a scratch copy, shared
 * by the hand derivation (corpus/derive.mjs) and the harness, so a key and the
 * run it judges see the same tree. Imports nothing from TestGuard.
 *
 * - `install: npm`: node_modules is a link to the subject's install, or, with
 *   `nodeModulesLayout: linked-entries` (#279), a real directory whose every
 *   entry is a symlink into that install (another checkout's packages).
 * - `install: npm-workspace`: the workspace's package links are recreated in
 *   the copy, so they resolve to the copy's packages: at the root for the npm
 *   layout, inside each package's own node_modules for the pnpm layout.
 * - `ignoredCopies` (#272): build output that real working trees hold untracked
 *   and git-ignored (vendored copies of packages); `untrackedSources` are the
 *   corpus-side originals of such copies, never part of the copy itself.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ALWAYS_SKIPPED = /(^|\/)(\.venv|\.out|__pycache__|\.testguard|test-results|playwright-report)(\/|$)/;

export class LayoutError extends Error {}

/** Copies the subject's own files (no installed dependencies, no counters) into `dir`. */
export function copySubjectFiles(subject, dir) {
  const counters = new Set(subject.config.counters ?? []);
  const untracked = subject.config.untrackedSources ?? [];
  cpSync(subject.dir, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(subject.dir, src);
      if (rel === '') return true;
      if (counters.has(rel) || ALWAYS_SKIPPED.test(rel)) return false;
      if (untracked.some((u) => rel === u || rel.startsWith(`${u}/`))) return false;
      return !/(^|\/)node_modules(\/|$)/.test(rel);
    },
  });
}

/** Ignored, untracked build copies (#272). Returns the top-level directories to git-ignore. */
export function placeIgnoredCopies(subject, dir) {
  const tops = new Set();
  for (const { from, to } of subject.config.ignoredCopies ?? []) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(join(subject.dir, from), join(dir, to), { recursive: true, filter: (s) => !/(^|\/)(node_modules|__pycache__)(\/|$)/.test(relative(subject.dir, s)) });
    tops.add(`${to.split('/')[0]}/`);
  }
  return [...tops];
}

function workspacePackages(dir) {
  const root = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const byName = new Map();
  for (const ws of root.workspaces ?? []) {
    const pj = join(dir, ws, 'package.json');
    if (existsSync(pj)) byName.set(JSON.parse(readFileSync(pj, 'utf8')).name, ws);
  }
  return byName;
}

/** node_modules for the copy, by the subject's install kind and the variant's layout. */
export function linkDependencies(subject, dir, { nodeModules } = {}) {
  const { install, nodeModulesLayout } = subject.config;
  if (install === 'npm-workspace') {
    const packages = workspacePackages(dir);
    const links = [];
    if ((subject.config.layout ?? 'npm') === 'pnpm') {
      // pnpm: each package links the workspace packages it depends on in its own node_modules.
      for (const [, ws] of packages) {
        const pkg = JSON.parse(readFileSync(join(dir, ws, 'package.json'), 'utf8'));
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          if (!packages.has(dep)) continue;
          const at = join(dir, ws, 'node_modules', dep);
          mkdirSync(dirname(at), { recursive: true });
          symlinkSync(relative(dirname(at), join(dir, packages.get(dep))), at);
          links.push(at);
        }
      }
    } else {
      for (const [name, ws] of packages) {
        const at = join(dir, 'node_modules', name);
        mkdirSync(dirname(at), { recursive: true });
        symlinkSync(relative(dirname(at), join(dir, ws)), at);
        links.push(at);
      }
    }
    for (const at of links) {
      const resolved = realpathSync(at);
      if (!resolved.startsWith(realpathSync(dir))) throw new LayoutError(`${subject.name}: workspace link ${relative(dir, at)} resolves outside the copy (${resolved})`);
    }
    return;
  }
  if (install !== 'npm') return;
  const source = nodeModules ?? join(subject.dir, 'node_modules');
  if (!existsSync(source)) return;
  if (nodeModulesLayout === 'linked-entries') {
    // #279: node_modules is a real directory, every entry a symlink into another checkout's install.
    mkdirSync(join(dir, 'node_modules'));
    for (const entry of readdirSync(source)) {
      if (entry.startsWith('@') && lstatSync(join(source, entry)).isDirectory()) {
        mkdirSync(join(dir, 'node_modules', entry));
        for (const sub of readdirSync(join(source, entry))) symlinkSync(join(source, entry, sub), join(dir, 'node_modules', entry, sub));
      } else {
        symlinkSync(join(source, entry), join(dir, 'node_modules', entry));
      }
    }
    return;
  }
  symlinkSync(source, join(dir, 'node_modules'), 'dir');
}

export function readLinkTarget(p) {
  return readlinkSync(p);
}

export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}
