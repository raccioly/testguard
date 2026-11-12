// Issue #279: a probe from a git worktree whose node_modules (root and per
// package) are symlinks to the main checkout's must never write into the main
// checkout's install. Measured on a pnpm workspace with 0.22.1: a runner
// command that ran pnpm in the scratch tree relinked through the borrowed
// levels (`.bin`, `.pnpm`, scopes, metadata files) and through a node_modules
// symlink an --include-dirty snapshot had captured, rewriting the main
// checkout's links to point into a scratch directory that was then deleted.
//
// The fixture is a pnpm-shaped install built by hand (no package manager, no
// network). The "package manager" is simulated by the writes one makes when
// it relinks: every file at a mirrored level rewritten, every link replaced.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createScratch, installsChangedSince, installsFingerprint } from '../src/probe/worktree.mjs';
import { listing } from './helpers/write-boundary.mjs';
import { commit, git } from './helpers/scope-project.mjs';

const roots = [];
const trees = [];
afterEach(() => {
  while (trees.length) trees.pop().cleanup();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});
const write = (root, files) => { for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); } };
const link = (root, at, to) => { mkdirSync(dirname(join(root, at)), { recursive: true }); symlinkSync(to, join(root, at)); };

/** A main checkout with a pnpm-shaped install, and a worktree whose node_modules are symlinks to it. */
function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tg-279-')));
  roots.push(base);
  const main = join(base, 'main');
  write(main, {
    'package.json': JSON.stringify({ name: 'ws', private: true, type: 'module' }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    '.gitignore': 'node_modules\n',
    'packages/a/package.json': JSON.stringify({ name: '@ws/a', type: 'module', exports: './src/a.js' }),
    'packages/a/src/a.js': "export { mul } from '@ws/b';\n",
    'packages/b/package.json': JSON.stringify({ name: '@ws/b', type: 'module', exports: './src/b.js' }),
    'packages/b/src/b.js': 'export const mul = (x, y) => x * y;\n',
    // The install: the store, its hoisted level, bins, metadata naming the checkout.
    'node_modules/.pnpm/tool@1.0.0/node_modules/tool/package.json': JSON.stringify({ name: 'tool', version: '1.0.0' }),
    'node_modules/.pnpm/tool@1.0.0/node_modules/tool/index.js': 'module.exports = 1;\n',
    'node_modules/.pnpm/tool@1.0.0/node_modules/tool/node_modules/.bin/helper': '#!/bin/sh\n',
    'node_modules/.pnpm/helper@2.0.0/node_modules/helper/package.json': JSON.stringify({ name: 'helper', version: '2.0.0' }),
    'node_modules/.pnpm/lock.yaml': 'lockfileVersion: 9\n',
    'node_modules/.pnpm/node_modules/.bin/helper': '#!/bin/sh\n',
    'node_modules/.bin/tool': '#!/bin/sh\nexec node "$basedir/../tool"\n',
    'node_modules/.modules.yaml': 'layoutVersion: 5\n',
    'packages/a/node_modules/.bin/tool': '#!/bin/sh\n',
  });
  writeFileSync(join(main, 'node_modules/.pnpm-workspace-state-v1.json'), JSON.stringify({ projects: { [main]: {}, [join(main, 'packages/a')]: {}, [join(main, 'packages/b')]: {} } }));
  link(main, 'node_modules/tool', '.pnpm/tool@1.0.0/node_modules/tool');
  link(main, 'node_modules/.pnpm/tool@1.0.0/node_modules/helper', '../../helper@2.0.0/node_modules/helper');
  link(main, 'node_modules/.pnpm/node_modules/helper', '../helper@2.0.0/node_modules/helper');
  link(main, 'packages/a/node_modules/tool', '../../../node_modules/.pnpm/tool@1.0.0/node_modules/tool');
  link(main, 'packages/a/node_modules/@ws/b', '../../../b');
  git(main, 'init', '-q', '-b', 'main');
  commit(main, 'base');
  const wt = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'));
  symlinkSync(join(main, 'packages/a/node_modules'), join(wt, 'packages/a/node_modules'));
  const installs = () => new Map([...listing(join(main, 'node_modules')), ...[...listing(join(main, 'packages/a/node_modules'))].map(([k, v]) => [`a/${k}`, v])]);
  return { base, main, wt, installs };
}

/** What a package manager does when it relinks an install: rewrite every file at a mirrored level, replace every link. */
function relinkLikeAPackageManager(nm) {
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) { unlinkSync(path); symlinkSync('/nonexistent/relinked', path); continue; }
      if (st.isFile()) { writeFileSync(path, 'rewritten by a package manager\n'); continue; }
      if (!st.isDirectory()) continue;
      if (existsSync(join(path, 'package.json'))) { if (existsSync(join(path, 'node_modules')) && !lstatSync(join(path, 'node_modules')).isSymbolicLink()) visit(join(path, 'node_modules')); continue; }
      visit(path);
    }
  };
  visit(nm);
}

describe('a scratch tree over a symlinked pnpm install never writes into it (#279)', () => {
  it('a package manager relinking every level of the scratch tree leaves the main checkout\'s install as it was', () => {
    const { main, wt, installs } = layout();
    const before = installs();
    expect(before.size).toBeGreaterThan(15);
    const tree = createScratch({ repoRoot: wt, projectDir: wt });
    trees.push(tree);
    // Every level a package manager writes is the scratch tree's own: no directory there is a link into the install.
    for (const level of ['node_modules', 'node_modules/.bin', 'node_modules/.pnpm', 'node_modules/.pnpm/node_modules', 'node_modules/.pnpm/tool@1.0.0/node_modules', 'packages/a/node_modules', 'packages/a/node_modules/@ws', 'packages/a/node_modules/.bin']) {
      expect(lstatSync(join(tree.root, level)).isSymbolicLink(), level).toBe(false);
    }
    // The metadata names the scratch tree, never the main checkout.
    const state = readFileSync(join(tree.root, 'node_modules/.pnpm-workspace-state-v1.json'), 'utf8');
    expect(state).not.toContain(main);
    expect(state).toContain(realpathSync(tree.root));
    relinkLikeAPackageManager(join(tree.root, 'node_modules'));
    relinkLikeAPackageManager(join(tree.root, 'packages/a/node_modules'));
    expect(installs()).toEqual(before);
  });

  it('replaces a node_modules symlink the checkout itself carries (an --include-dirty snapshot of the worktree)', () => {
    const { wt, installs } = layout();
    // What `--include-dirty` captures when .gitignore names `node_modules/` (directories only): the links themselves.
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'snapshot', '--no-verify');
    expect(git(wt, 'ls-files', 'node_modules', 'packages/a/node_modules')).not.toBe('');
    const before = installs();
    const tree = createScratch({ repoRoot: wt, projectDir: wt });
    trees.push(tree);
    for (const level of ['node_modules', 'packages/a/node_modules']) expect(lstatSync(join(tree.root, level)).isSymbolicLink(), level).toBe(false);
    relinkLikeAPackageManager(join(tree.root, 'node_modules'));
    relinkLikeAPackageManager(join(tree.root, 'packages/a/node_modules'));
    expect(installs()).toEqual(before);
  });

  it('the install fingerprint sees a write into a borrowed install, and names the path', () => {
    const { main, wt } = layout();
    const before = installsFingerprint({ repoRoot: wt });
    expect(before.size).toBeGreaterThan(5);
    expect(installsChangedSince(before, { repoRoot: wt })).toEqual([]);
    unlinkSync(join(main, 'packages/a/node_modules/tool'));
    symlinkSync('/scratch/gone/tool', join(main, 'packages/a/node_modules/tool'));
    writeFileSync(join(main, 'node_modules/.bin/tool'), '#!/bin/sh\n# rewritten\n');
    expect(installsChangedSince(before, { repoRoot: wt }).map((path) => relative(main, path))).toEqual(['node_modules/.bin/tool', 'packages/a/node_modules/tool']);
  });
});
