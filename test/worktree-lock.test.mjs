// One lock around scratch-worktree allocation (issue #237), and scratch git
// that ignores the caller's GIT_* environment, hooks, fsmonitor and prompts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_NAME, lockIsStale, parseLock, withWorktreeLock } from '../src/probe/worktree-lock.mjs';
import { NO_HOOKS, gitCommonDir, scratchGitEnv } from '../src/git.mjs';
import { createScratch } from '../src/probe/worktree.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-lock-'));
  const g = (...a) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  g('commit', '-qm', 'one');
  return dir;
}

describe('lock staleness', () => {
  it('breaks a lock only when its owner is provably gone on this host', () => {
    const alive = (pid) => pid === 1;
    expect(lockIsStale({ pid: 99, host: hostname() }, { alive })).toBe(true);
    expect(lockIsStale({ pid: 1, host: hostname() }, { alive })).toBe(false);
    // Another host's process table is not ours to judge.
    expect(lockIsStale({ pid: 99, host: 'elsewhere.invalid' }, { alive })).toBe(false);
    // Unreadable (a write in progress) is waited on, never broken.
    expect(lockIsStale(null, { alive })).toBe(false);
    expect(parseLock('{"pid":12}')).toEqual({ pid: 12 });
    expect(parseLock('{"pid":0}')).toBeNull();
    expect(parseLock('half-written')).toBeNull();
  });

  it('takes over a stale lock, and times out on a live one instead of proceeding unlocked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-lockdir-'));
    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 424242, host: hostname() }));
    expect(withWorktreeLock(dir, () => 'ran', { alive: () => false })).toBe('ran');
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);

    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 424242, host: hostname() }));
    let t = 0;
    let ran = false;
    expect(() => withWorktreeLock(dir, () => { ran = true; }, { alive: () => true, timeoutMs: 1000, now: () => t, pause: (ms) => { t += ms; } }))
      .toThrow(/pid 424242/);
    expect(ran).toBe(false);
    expect(existsSync(join(dir, LOCK_NAME))).toBe(true); // a live owner's lock is never removed
  });

  it('releases the lock when the critical section throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-lockdir-'));
    expect(() => withWorktreeLock(dir, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
  });

  it('serializes two processes: their critical sections never overlap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-lockdir-'));
    const log = join(dir, 'log');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { withWorktreeLock } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/probe/worktree-lock.mjs')).href)};
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      for (let i = 0; i < 3; i++) withWorktreeLock(${JSON.stringify(dir)}, () => {
        appendFileSync(${JSON.stringify(log)}, 'enter ' + process.pid + '\\n');
        pause(60);
        appendFileSync(${JSON.stringify(log)}, 'leave ' + process.pid + '\\n');
      });`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    await Promise.all([run(), run()]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(12);
    for (let i = 0; i < lines.length; i += 2) {
      const [enter, leave] = [lines[i].split(' '), lines[i + 1].split(' ')];
      expect([enter[0], leave[0]]).toEqual(['enter', 'leave']);
      expect(leave[1]).toBe(enter[1]); // nobody else entered in between
    }
  }, 20_000);
});

describe('createScratch takes the lock in the git common directory', () => {
  it('waits for a live holder before adding a worktree', async () => {
    const dir = repo();
    const common = gitCommonDir(dir);
    expect(existsSync(common)).toBe(true);
    // Another process holds the lock for 0.7 s.
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withWorktreeLock } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/probe/worktree-lock.mjs')).href)};
      withWorktreeLock(${JSON.stringify(common)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });`]);
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const started = Date.now();
    const s = createScratch({ repoRoot: dir, projectDir: dir });
    const waited = Date.now() - started;
    s.cleanup();
    await new Promise((resolve) => holder.once('close', resolve));
    expect(waited).toBeGreaterThan(500);
    expect(existsSync(join(common, LOCK_NAME))).toBe(false);
  }, 20_000);

  it('a linked worktree locks in the common directory it shares with the main tree', () => {
    const dir = repo();
    const linked = join(mkdtempSync(join(tmpdir(), 'tg-linked-')), 'wt');
    spawnSync('git', [...FIXTURE_GIT, 'worktree', 'add', '-q', '--detach', linked], { cwd: dir });
    expect(gitCommonDir(linked)).toBe(gitCommonDir(dir));
  });
});

describe('scratch git is isolated from the caller', () => {
  it('strips every inherited GIT_* variable and disables prompts', () => {
    const env = scratchGitEnv({ PATH: '/bin', HOME: '/h', GIT_DIR: '/x', GIT_INDEX_FILE: '/i', GIT_WORK_TREE: '/w', git_trace: '1' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0' });
  });

  it('disables hooks and fsmonitor on every scratch git call', () => {
    expect(NO_HOOKS).toContain('core.fsmonitor=false');
    expect(NO_HOOKS.some((option) => option.startsWith('core.hooksPath='))).toBe(true);
  });

  it('a GIT_INDEX_FILE inherited from a hook does not leak into the scratch checkout', () => {
    const dir = repo();
    const bogus = join(mkdtempSync(join(tmpdir(), 'tg-index-')), 'index');
    mkdirSync(dirname(bogus), { recursive: true });
    const before = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = bogus;
    try {
      const s = createScratch({ repoRoot: dir, projectDir: dir });
      expect(readFileSync(join(s.projectDir, 'a.txt'), 'utf8')).toBe('one\n');
      s.cleanup();
    } finally {
      if (before === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = before;
    }
    // Had it leaked, `worktree add` would have written its index here.
    expect(existsSync(bogus)).toBe(false);
  });
});
