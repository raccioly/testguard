// Shared by the #301 init tests: a throwaway repository, git calls that do not
// depend on the machine's git config, and a hook runner with a fake testguard.
import { afterAll, beforeAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

export const V = '0.25.0';
export { devNull };

/**
 * Register the hooks every #301 init test file needs. Activation reads the
 * clone's git config, so a machine's (or the hermeticity job's) global
 * core.hooksPath must not decide these tests: they run with no global or
 * system config, and the environment is restored after. Returns `made`, the
 * directories to remove at the end (a test pushes its own onto it).
 */
export function hermeticRepos() {
  const made = [];
  const saved = {};
  beforeAll(() => { for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k]; process.env.GIT_CONFIG_GLOBAL = devNull; process.env.GIT_CONFIG_NOSYSTEM = '1'; });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  return made;
}

export const git = (cwd, ...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
/** git reading the clone's real config (FIXTURE_GIT pins core.hooksPath, which is the thing under test). */
export const cfg = (dir, ...args) => spawnSync('git', ['config', ...args], { cwd: dir, encoding: 'utf8' });
export const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
export const put = (dir, f, text, mode) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text, mode ? { mode } : undefined); };

export function repo(made, { commit = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-owned-')));
  made.push(dir);
  git(dir, 'init', '-q');
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** Run a hook file with a fake testguard first on PATH; the fake logs every call it gets. */
export function run(cwd, hook, { args = [], input = '' } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'tg-owned-bin-'));
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'testguard'), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${V}; exit 0; fi\necho "$*" >> "${log}"\nexit 0\n`);
  chmodSync(join(bin, 'testguard'), 0o755);
  const r = spawnSync('sh', [hook, ...args], { cwd, input, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: cwd, GIT_CONFIG_GLOBAL: devNull } });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(bin, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, calls };
}
