// @req FR-10
// The declared write boundary (#239), checked cheaply: where the scratch
// directory comes from, what lives under it, and that a read-only install is
// never written. The slow, real-runner proof is write-boundary.acceptance.test.mjs.
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { childScope, resolveScratchDir, scratchConfigured, scratchRoot, withScratchBase } from '../src/scratch-dir.mjs';
import { linkNodeModules, nearestNodeModulesWritable, writable } from '../src/probe/node-modules-link.mjs';
import { createScratch, PreconditionError, writeBoundary } from '../src/probe/worktree.mjs';
import { snapshotWorkingTree } from '../src/git.mjs';
import { worktreeLockDir } from '../src/probe/worktree-lock.mjs';
import { parseCommandTemplate, resetRunnerCache, runProcess } from '../src/probe/runners/shared.mjs';
import { configLoaderArgs } from '../src/probe/runners/vitest.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
const dir = (prefix = 'tg-scratch-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(d); return d; };
afterEach(() => {
  for (const d of made.splice(0)) { spawnSync('chmod', ['-R', 'u+w', d]); rmSync(d, { recursive: true, force: true }); }
});
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function repo() {
  const d = dir('tg-wb-repo-');
  const g = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(d, 'a.txt'), 'a\n');
  g('add', '-A'); g('commit', '-qm', 'one');
  return d;
}

describe('which directory is the scratch directory', () => {
  it('is the flag, else TESTGUARD_SCRATCH_DIR, else none (the OS temp directory)', () => {
    const flag = dir(); const env = dir();
    expect(resolveScratchDir(flag, { TESTGUARD_SCRATCH_DIR: env })).toBe(flag);
    expect(resolveScratchDir(undefined, { TESTGUARD_SCRATCH_DIR: env })).toBe(env);
    expect(resolveScratchDir(undefined, {})).toBeUndefined();
    expect(scratchRoot()).toBe(tmpdir());
    expect(scratchConfigured()).toBe(false);
  });

  it('is refused, and nothing is created, when it does not exist or is not a directory', () => {
    const parent = dir();
    const missing = join(parent, 'not-here');
    expect(() => resolveScratchDir(missing, {})).toThrow(PreconditionError);
    expect(() => resolveScratchDir(missing, {})).toThrow(/does not exist/);
    expect(readdirSync(parent)).toEqual([]);
    writeFileSync(join(parent, 'file'), 'x');
    expect(() => resolveScratchDir(join(parent, 'file'), {})).toThrow(/not a directory/);
    expect(() => resolveScratchDir('', {})).toThrow(/must name a directory/); // never read as the current directory
    expect(() => resolveScratchDir('  ', {})).toThrow(PreconditionError);
  });

  it.skipIf(isRoot)('is refused, and nothing is written, when it cannot be written', () => {
    const locked = dir();
    chmodSync(locked, 0o555);
    expect(() => resolveScratchDir(locked, {})).toThrow(/not usable/);
    expect(readdirSync(locked)).toEqual([]);
  });

  it('is carried by the call, so two concurrent probes never see each other\'s directory', async () => {
    const a = dir(); const b = dir();
    const seen = await Promise.all([a, b].map((base) => withScratchBase(base, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [scratchRoot(), scratchConfigured()];
    })));
    expect(seen).toEqual([[a, true], [b, true]]);
    expect(scratchRoot()).toBe(tmpdir());
  });
});

describe('what lives under the scratch directory', () => {
  it('createScratch puts the worktree under it', () => {
    const repoDir = repo(); const base = dir();
    withScratchBase(base, () => {
      const s = createScratch({ repoRoot: repoDir, projectDir: repoDir });
      expect(dirname(s.root)).toBe(base);
      s.cleanup();
    });
  });

  it('the temporary git index lives under it: a scratch directory that cannot be written stops the snapshot', () => {
    const repoDir = repo(); const base = dir();
    writeFileSync(join(repoDir, 'dirty.txt'), 'x');
    expect(withScratchBase(base, () => snapshotWorkingTree(repoDir))).toMatch(/^[0-9a-f]{40}$/);
    expect(readdirSync(base)).toEqual([]);
    if (!isRoot) {
      chmodSync(base, 0o555);
      expect(() => withScratchBase(base, () => snapshotWorkingTree(repoDir))).toThrow();
    }
  });

  it('the worktree allocation lock lives under it, not in the OS temp directory', () => {
    const base = dir();
    const lockDir = withScratchBase(base, () => worktreeLockDir('/some/repo/.git'));
    expect(lockDir.startsWith(join(base, 'testguard-locks'))).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('the runner report file and the child\'s temp directory live under it, and the temp directory is gone after the run', async () => {
    const base = dir();
    const script = "require('fs').writeFileSync(process.argv[2], JSON.stringify({ out: process.argv[2], tmp: process.env.TMPDIR, data: process.env.XDG_DATA_HOME, files: [] }))";
    const reported = await withScratchBase(base, () => runProcess({
      projectDir: base, files: ['a.test.js'], commandTemplate: parseCommandTemplate(`${process.execPath} -e "${script}" {files} {out}`),
      parse: (report) => ({ run: { outcome: 'pass' }, report }),
    }));
    expect(reported.report.out.startsWith(base)).toBe(true);
    expect(dirname(reported.report.tmp)).toBe(base);
    expect(reported.report.data.startsWith(reported.report.tmp)).toBe(true);
    expect(readdirSync(base)).toEqual([]);
  });

  it('without a scratch directory a child keeps the operating system\'s own temp directory', () => {
    expect(childScope().env).toEqual({});
    const base = dir();
    const scope = withScratchBase(base, () => childScope());
    expect(Object.keys(scope.env).sort()).toEqual(['TEMP', 'TMP', 'TMPDIR', 'XDG_DATA_HOME']);
    expect(existsSync(scope.env.TMPDIR)).toBe(true);
    scope.dispose();
    expect(existsSync(scope.env.TMPDIR)).toBe(false);
  });
});

describe('a node_modules that is never written through', () => {
  const install = () => {
    const nm = join(dir('tg-install-'), 'node_modules');
    mkdirSync(join(nm, 'dep'), { recursive: true });
    mkdirSync(join(nm, '@scope', 'pkg'), { recursive: true });
    mkdirSync(join(nm, '.bin'));
    mkdirSync(join(nm, '.vite', 'vitest'), { recursive: true });
    mkdirSync(join(nm, '.cache'));
    writeFileSync(join(nm, 'dep', 'index.js'), 'module.exports = 1\n');
    writeFileSync(join(nm, 'dep', 'package.json'), '{"name":"dep"}');
    writeFileSync(join(nm, '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}');
    writeFileSync(join(nm, '.bin', 'dep'), '#!/bin/sh\n');
    writeFileSync(join(nm, '.package-lock.json'), '{}');
    return nm;
  };

  it('is a real directory in the scratch tree whose entries link to the install; tool caches are left behind', () => {
    const nm = install(); const at = join(dir(), 'node_modules');
    linkNodeModules(nm, at);
    expect(lstatSync(at).isDirectory() && !lstatSync(at).isSymbolicLink()).toBe(true);
    expect(readdirSync(at).sort()).toEqual(['.bin', '.package-lock.json', '@scope', 'dep']);
    expect(lstatSync(join(at, 'dep')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(at, 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n');
    // #279: every level a package manager writes is the scratch tree's own.
    for (const level of ['.bin', '@scope']) expect(lstatSync(join(at, level)).isSymbolicLink(), level).toBe(false);
    for (const file of ['.bin/dep', '.package-lock.json']) expect(lstatSync(join(at, file)).isSymbolicLink(), file).toBe(false);
    expect(lstatSync(join(at, '@scope', 'pkg')).isSymbolicLink()).toBe(true);
  });

  it('a write to .vite-temp or .vite through it lands in the scratch tree, never in the install', () => {
    const nm = install(); const at = join(dir(), 'node_modules');
    linkNodeModules(nm, at);
    mkdirSync(join(at, '.vite-temp'));
    writeFileSync(join(at, '.vite-temp', 'config.mjs'), 'x');
    mkdirSync(join(at, '.vite'));
    expect(existsSync(join(nm, '.vite-temp'))).toBe(false);
    expect(readdirSync(join(nm, '.vite'))).toEqual(['vitest']);
  });

  it.skipIf(isRoot)('createScratch links a READ-ONLY install and the scratch tree can still write its own caches', () => {
    const repoDir = repo(); const base = dir();
    const nm = install();
    chmodSync(nm, 0o555);
    const s = withScratchBase(base, () => createScratch({ repoRoot: repoDir, projectDir: repoDir, nodeModules: nm }));
    mkdirSync(join(s.root, 'node_modules', '.vite-temp'));
    expect(existsSync(join(nm, '.vite-temp'))).toBe(false);
    s.cleanup();
  });

  it.skipIf(isRoot)('writable() and the evidence signal say whether the install could be written, and carry no path', () => {
    const repoDir = repo(); const nm = install();
    expect(writeBoundary({ repoRoot: repoDir, nodeModules: nm })).toEqual({ scratchDir: 'default', nodeModulesWritable: true });
    chmodSync(nm, 0o555);
    expect(writable(nm)).toBe(false);
    expect(writeBoundary({ repoRoot: repoDir, nodeModules: nm })).toEqual({ scratchDir: 'default', nodeModulesWritable: false });
    expect(withScratchBase(dir(), () => writeBoundary({ repoRoot: repoDir, nodeModules: nm }))).toEqual({ scratchDir: 'configured', nodeModulesWritable: false });
  });

  it.skipIf(isRoot)('says writable when ANY linked install could be written: a read-only explicit one beside a writable project one', () => {
    const repoDir = repo(); const ro = install();
    mkdirSync(join(repoDir, 'node_modules'));
    chmodSync(ro, 0o555);
    expect(writeBoundary({ repoRoot: repoDir, nodeModules: ro }).nodeModulesWritable).toBe(true);
  });

  it('records nothing about node_modules when none is linked (a Python project)', () => {
    expect(writeBoundary({ repoRoot: repo() })).toEqual({ scratchDir: 'default' });
  });

  it.skipIf(isRoot)('discovery in the caller\'s own tree asks vitest 4+ for a config loader that writes nothing, only when the install is read-only', () => {
    const project = dir('tg-proj-');
    const nm = join(dir('tg-nm-'), 'node_modules');
    mkdirSync(join(nm, 'vitest'), { recursive: true });
    writeFileSync(join(nm, 'vitest', 'package.json'), JSON.stringify({ name: 'vitest', version: '5.0.2', bin: { vitest: 'vitest.mjs' } }));
    writeFileSync(join(nm, 'vitest', 'vitest.mjs'), '');
    symlinkSync(nm, join(project, 'node_modules'), 'dir');
    resetRunnerCache();
    expect(nearestNodeModulesWritable(project)).toBe(true);
    expect(configLoaderArgs(project)).toEqual([]);
    chmodSync(nm, 0o555);
    expect(nearestNodeModulesWritable(project)).toBe(false);
    expect(configLoaderArgs(project)).toEqual(['--configLoader', 'runner']);
    chmodSync(nm, 0o755);
    writeFileSync(join(nm, 'vitest', 'package.json'), JSON.stringify({ name: 'vitest', version: '3.2.4', bin: { vitest: 'vitest.mjs' } }));
    chmodSync(nm, 0o555);
    resetRunnerCache();
    expect(configLoaderArgs(project)).toEqual([]); // 3.x: the flag is not known to exist, so it is not passed
  });
});
