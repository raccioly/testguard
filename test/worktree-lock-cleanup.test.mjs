// Holes found by hand-made wrong builds of createScratch (issue #237): removal
// must take the same lock as allocation (the prune race the lock exists for),
// and the lock directory must be the one under the scratch base.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_NAME, worktreeLockDir } from '../src/probe/worktree-lock.mjs';
import { gitCommonDir } from '../src/git.mjs';
import { createScratch } from '../src/probe/worktree.mjs';
import { withScratchBase } from '../src/scratch-dir.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-lock-cleanup-'));
  const g = (...a) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  g('commit', '-qm', 'one');
  return dir;
}

describe('removing a scratch worktree takes the allocation lock', () => {
  it('cleanup() blocks while another process holds the lock, and removes the tree after it is released', async () => {
    const dir = repo();
    const lockDir = worktreeLockDir(gitCommonDir(dir));
    const s = createScratch({ repoRoot: dir, projectDir: dir });
    expect(existsSync(s.root)).toBe(true);
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withWorktreeLock } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/probe/worktree-lock.mjs')).href)};
      withWorktreeLock(${JSON.stringify(lockDir)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });`]);
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const started = Date.now();
    s.cleanup();
    const waited = Date.now() - started;
    await new Promise((resolve) => holder.once('close', resolve));
    expect(waited).toBeGreaterThan(500);
    expect(existsSync(s.root)).toBe(false);
    expect(existsSync(join(lockDir, LOCK_NAME))).toBe(false);
  }, 20_000);
});

describe('createScratch keeps its lock under the scratch base, outside the repository', () => {
  it('creating a scratch tree creates the repository-keyed lock directory beneath the scratch directory, and nowhere else', () => {
    const dir = repo();
    const base = mkdtempSync(join(tmpdir(), 'tg-lock-base-'));
    expect(existsSync(join(base, 'testguard-locks'))).toBe(false);
    const s = withScratchBase(base, () => createScratch({ repoRoot: dir, projectDir: dir, scratchBase: base }));
    try {
      const locks = readdirSync(join(base, 'testguard-locks'));
      expect(locks).toHaveLength(1);
      expect(join(base, 'testguard-locks', locks[0])).toBe(withScratchBase(base, () => worktreeLockDir(gitCommonDir(dir))));
      expect(existsSync(join(dir, 'testguard-locks'))).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});
