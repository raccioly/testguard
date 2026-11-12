// `probe --changed auto` (issue #270): the base a pre-push hook needs, found
// offline, and a full probe — never a skip — when there is none.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAutoChangedRef } from '../src/gate/changed.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

function repoWithRemote() {
  const remote = mkdtempSync(join(tmpdir(), 'tg-auto-remote-'));
  const dir = mkdtempSync(join(tmpdir(), 'tg-auto-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'a');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, remote, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); } };
}

describe('resolveAutoChangedRef', () => {
  it('CI says the base first', () => {
    expect(resolveAutoChangedRef({ env: { GITHUB_BASE_REF: 'main' }, projectDir: tmpdir() })).toEqual({ ref: 'origin/main', from: 'GITHUB_BASE_REF', required: false });
  });

  it('on the default branch with no remote HEAD, the branch\'s own upstream: the commits not pushed yet', () => {
    const r = repoWithRemote();
    try {
      writeFileSync(join(r.dir, 'b.txt'), 'b\n');
      git(r.dir, 'add', '-A');
      git(r.dir, 'commit', '-qm', 'b');
      expect(resolveAutoChangedRef({ env: {}, projectDir: r.dir })).toEqual({ ref: 'origin/main', from: 'branch upstream (the commits not pushed yet)', required: false });
    } finally { r.cleanup(); }
  });

  it('a feature branch compares against the remote default branch', () => {
    const r = repoWithRemote();
    try {
      git(r.dir, 'remote', 'set-head', 'origin', 'main');
      git(r.dir, 'checkout', '-q', '-b', 'topic');
      expect(resolveAutoChangedRef({ env: {}, projectDir: r.dir })).toEqual({ ref: 'origin/main', from: 'remote default branch', required: false });
    } finally { r.cleanup(); }
  });

  it('no remote, no upstream: nothing, so the caller probes everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-auto-none-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'a');
      expect(resolveAutoChangedRef({ env: {}, projectDir: dir })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
