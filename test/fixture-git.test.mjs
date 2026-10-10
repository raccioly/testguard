import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './helpers/git.mjs';

/**
 * A machine whose global git config would break an unpinned fixture: a hooks
 * directory whose every hook fails, and mandatory signing through a gpg that
 * always fails. Applied to one spawn at a time through GIT_CONFIG_GLOBAL, so
 * nothing else in the suite sees it.
 */
function hostileMachine() {
  const root = mkdtempSync(join(tmpdir(), 'tg-hostile-'));
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  const fired = join(root, 'fired');
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${fired}'\nexit 1\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  const config = join(root, 'gitconfig');
  writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n`);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git([...FIXTURE_GIT, 'init', '-q']);
  return { git, fired };
}

const identity = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid'];

describe('fixture git options neutralise the machine\'s global git config', () => {
  it('commits through failing global hooks and mandatory signing, running neither', () => {
    const { git, fired } = hostileMachine();
    const r = git([...FIXTURE_GIT, ...identity, 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(fired)).toBe(false);
    expect(git(['log', '--format=%G?', '-1']).stdout.trim()).toBe('N');
  });

  it('is needed: the same commit without them fails on that machine', () => {
    const { git } = hostileMachine();
    expect(git([...identity, 'commit', '-q', '--allow-empty', '-m', 'fixture']).status).not.toBe(0);
  });
});
