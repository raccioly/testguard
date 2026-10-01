import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {ROOT} from './helpers/release-project.mjs';
describe('release.yml: the verified formula is deployed, not merely staged', () => {
  it('publishes to the live tap before the source formula PR can complete', () => {
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(text).toContain('HOMEBREW_TAP_DEPLOY_KEY: $' + '{{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}');
    const verified = text.indexOf('sync-release-version.mjs --check --online');
    const published = text.indexOf('publish-homebrew-tap.sh "$VERSION"');
    const sourceCommit = text.indexOf('git add packaging/homebrew/testguard.rb');
    expect(verified).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(verified);
    expect(sourceCommit).toBeGreaterThan(published);
  });
});

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  expect(result.status, command + ' ' + args.join(' ') + '\n' + result.stderr).toBe(0);
  return result;
}

function tapRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-homebrew-tap-'));
  const remote = join(dir, 'tap.git');
  const seed = join(dir, 'seed');
  checked('git', ['init', '--bare', '--initial-branch=main', remote]);
  checked('git', ['init', '--initial-branch=main', seed]);
  checked('git', ['-C', seed, 'config', 'user.name', 'fixture']);
  checked('git', ['-C', seed, 'config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(seed, 'Formula'), { recursive: true });
  const current = readFileSync(join(ROOT, 'packaging', 'homebrew', 'testguard.rb'), 'utf8');
  const stale = current
    .replace(/testguard-cli-[0-9]+\.[0-9]+\.[0-9]+\.tgz/, 'testguard-cli-0.8.0.tgz')
    .replace(/^(\s*sha256 ")[0-9a-f]{64}(")/m, '$1' + 'a'.repeat(64) + '$2');
  writeFileSync(join(seed, 'Formula', 'testguard.rb'), stale);
  checked('git', ['-C', seed, 'add', 'Formula/testguard.rb']);
  checked('git', ['-C', seed, 'commit', '-m', 'stale testguard formula']);
  checked('git', ['-C', seed, 'remote', 'add', 'origin', remote]);
  checked('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
  return { remote, original: stale };
}

describe('publish-homebrew-tap: the validated source formula reaches the actual tap', () => {
  const script = join(ROOT, '.github', 'scripts', 'publish-homebrew-tap.sh');
  const source = join(ROOT, 'packaging', 'homebrew', 'testguard.rb');
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const remoteFormula = (remote) => checked('git', ['--git-dir', remote, 'show', 'main:Formula/testguard.rb']).stdout;
  const commitCount = (remote) => Number(checked('git', ['--git-dir', remote, 'rev-list', '--count', 'main']).stdout.trim());

  it('pushes the exact formula once and is idempotent on a retry', () => {
    const { remote, original } = tapRemote();
    const env = { ...process.env, HOMEBREW_TAP_REMOTE: remote, HOMEBREW_TAP_SOURCE: source };
    expect(remoteFormula(remote)).toBe(original);

    const first = spawnSync(script, [version], { cwd: ROOT, env, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('published TestGuard v' + version);
    expect(remoteFormula(remote)).toBe(readFileSync(source, 'utf8'));
    const afterFirst = commitCount(remote);

    const retry = spawnSync(script, [version], { cwd: ROOT, env, encoding: 'utf8' });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('already carries TestGuard v' + version);
    expect(commitCount(remote)).toBe(afterFirst);
  });

  it('refuses to publish when the requested release and formula version disagree', () => {
    const { remote, original } = tapRemote();
    const env = { ...process.env, HOMEBREW_TAP_REMOTE: remote, HOMEBREW_TAP_SOURCE: source };
    const result = spawnSync(script, ['9.8.7'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match release 9.8.7');
    expect(remoteFormula(remote)).toBe(original);
  });
});
