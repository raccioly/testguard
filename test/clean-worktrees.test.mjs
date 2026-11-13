// Orphaned scratch trees and the git worktree registry (#311): a scratch tree
// carries an owner record from creation; removing a dead probe's tree also
// prunes its registration, in the repository the command works on and no other,
// without waiting for a live probe's lock. Real git repositories.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOrphans, scanOrphans } from '../src/clean/orphans.mjs';
import { ownersDir } from '../src/clean/owner.mjs';
import { createScratch } from '../src/probe/worktree.mjs';
import { gitCommonDir } from '../src/git.mjs';
import { withScratchBase } from '../src/scratch-dir.mjs';
import { LOCK_NAME, worktreeLockDir } from '../src/probe/worktree-lock.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

// Real git repositories and real child processes: a loaded machine (a fan-out of probes) must not turn a slow start into a failure.
vi.setConfig({ testTimeout: 30_000 });
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const root = (prefix = 'tg-clean-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

const HOST = 'this-host';
const DEAD = 424242;
const LIVE = 31337;
const alive = (pid) => pid === LIVE;
const options = { alive, host: HOST };

describe('worktree registrations', () => {
  const git = (cwd, ...args) => execFileSync('git', [...FIXTURE_GIT, ...args], { cwd, encoding: 'utf8' });
  const registered = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
  const repo = () => {
    const dir = root('tg-clean-repo-');
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
    return dir;
  };

  it('a scratch tree is created with an owner record naming this process, and cleanup drops the record', () => {
    const dir = repo();
    const base = root();
    const scratch = createScratch({ repoRoot: dir, projectDir: dir, scratchBase: base });
    const file = join(ownersDir(base), `${scratch.root.slice(scratch.root.lastIndexOf('/') + 1)}.json`);
    expect(JSON.parse(readFileSync(file))).toMatchObject({ pid: process.pid });
    expect(scanOrphans(base, { alive: () => true }).orphans).toEqual([]);
    scratch.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('removing a dead probe\'s tree also removes its git worktree registration in the repository the command works on, and prunes no other', () => {
    const dir = repo();
    const other = repo();
    const base = root();
    const foreign = join(base, 'foreign-worktree');
    git(other, 'worktree', 'add', '--detach', foreign, 'HEAD');
    rmSync(foreign, { recursive: true, force: true });
    // A probe killed after `git worktree add`: the tree and its registration are left, the record names a dead pid.
    const name = 'testguard-jjjjjj';
    git(dir, 'worktree', 'add', '--detach', join(base, name), 'HEAD');
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), `${name}.json`), JSON.stringify({ pid: DEAD, host: HOST }));
    expect(registered(dir)).toBe(2);
    const report = cleanOrphans({ base, repoRoot: dir, ...options });
    expect(report.removed.map((r) => r.kind)).toEqual(['scratch-tree']);
    expect(report.worktrees).toHaveLength(1);
    expect(existsSync(join(base, name))).toBe(false);
    expect(registered(dir)).toBe(1);
    // The other repository's dangling registration is its own business: this command was not pointed at it.
    expect(registered(other)).toBe(2);
  });

  it('a dry run reports the registration it would prune and prunes nothing', () => {
    const dir = repo();
    const base = root();
    const gone = join(base, 'gone-worktree');
    git(dir, 'worktree', 'add', '--detach', gone, 'HEAD');
    rmSync(gone, { recursive: true, force: true });
    const report = cleanOrphans({ base, repoRoot: dir, dryRun: true, ...options });
    expect(report.worktrees).toHaveLength(1);
    expect(registered(dir)).toBe(2);
    expect(cleanOrphans({ base, repoRoot: dir, ...options }).worktrees).toHaveLength(1);
    expect(registered(dir)).toBe(1);
  });

  it('the registry prune waits for no one: a probe holding the repository\'s lock leaves it for the next run', () => {
    const dir = repo();
    const base = root();
    const gone = join(base, 'gone-worktree');
    git(dir, 'worktree', 'add', '--detach', gone, 'HEAD');
    rmSync(gone, { recursive: true, force: true });
    withScratchBase(base, () => {
      const lockDir = worktreeLockDir(gitCommonDir(dir), base);
      writeFileSync(join(lockDir, LOCK_NAME), JSON.stringify({ pid: LIVE, host: HOST, at: 'x' }));
    });
    const started = Date.now();
    const report = cleanOrphans({ base, repoRoot: dir, lockWaitMs: 150, ...options });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.worktrees).toEqual([]);
    expect(registered(dir)).toBe(2);
  });
});

