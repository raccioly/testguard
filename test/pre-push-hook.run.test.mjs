// #293 review B: the generated pre-push hook is EXECUTED, never only parsed.
// Fake `testguard` binaries on PATH stand in for every install a user may
// have: too old for the block's flags, one that refuses a flag (exit 3), and
// probes that exit 0, 1 and 2; plus none installed and the skip variable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_MIN_VERSION, prePushScript } from '../src/init/managed.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

let repo;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'tg-hook-run-'));
  spawnSync('git', [...FIXTURE_GIT, 'init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.githooks'));
  writeFileSync(join(repo, '.githooks/pre-push'), prePushScript('.', { version: HOOK_MIN_VERSION }));
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Run the hook with a fake testguard (or none) first on PATH; returns status, stderr and the probe arguments it saw. */
function push({ version = HOOK_MIN_VERSION, code = 0, installed = true, env = {} } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'tg-hook-bin-'));
  const log = join(bin, 'args.log');
  writeFileSync(log, '');
  if (installed) {
    writeFileSync(join(bin, 'testguard'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version}"; exit 0; fi\necho "$*" >> "${log}"\nexit ${code}\n`);
    chmodSync(join(bin, 'testguard'), 0o755);
  }
  const r = spawnSync('sh', ['.githooks/pre-push'], { cwd: repo, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: repo, ...env } });
  const args = readFileSync(log, 'utf8').trim();
  rmSync(bin, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr.trim(), args };
}

describe('the managed pre-push hook, run', () => {
  it('passes exactly the fast arguments and lets a clean probe through', () => {
    expect(push({ code: 0 })).toEqual({ status: 0, stderr: '', args: 'probe --changed auto --when-no-base skip --quiet' });
  });
  it('refuses the push on exit 1 (unproven) and exit 2 (could not evaluate): 2 is never swallowed', () => {
    expect(push({ code: 1 }).status).not.toBe(0);
    expect(push({ code: 2 }).status).not.toBe(0);
  });
  it('lets a usage error (exit 3) through with one line', () => {
    const r = push({ code: 3 });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^testguard: the hook's probe command was a usage error \(exit 3/);
    expect(r.stderr.split('\n')).toHaveLength(1);
  });
  it('never hands its flags to a binary older than the template needs: one line, both versions, push goes through', () => {
    const r = push({ version: '0.24.0', code: 3 });
    expect(r.status).toBe(0);
    expect(r.args).toBe('');
    expect(r.stderr).toBe(`testguard: the installed TestGuard (0.24.0) is older than ${HOOK_MIN_VERSION}, which this hook needs, so this push was not probed. Install it: npm i -D --save-exact testguard-cli@${HOOK_MIN_VERSION}, or brew install raccioly/tap/testguard`);
    expect(push({ version: 'testguard 99.0.0', code: 0 }).args).toBe('probe --changed auto --when-no-base skip --quiet');
    expect(push({ version: 'no version here', code: 0 }).args).toBe('');
  });
  it('with nothing installed, says how to install and lets the push through, fetching nothing', () => {
    const r = push({ installed: false });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^testguard: not installed here, so this push was not probed \(CI is the gate\)\. Install it: npm i -D --save-exact testguard-cli@/);
  });
  it('never advises installing a version older than the block needs', () => {
    expect(prePushScript('.', { version: '0.1.0' })).not.toContain('testguard-cli@0.1.0');
    expect(prePushScript('.', { version: '0.1.0' })).toContain(`testguard-cli@${HOOK_MIN_VERSION}`);
  });
  it('TESTGUARD_SKIP_HOOK=1 skips it with a one-line notice', () => {
    const r = push({ code: 1, env: { TESTGUARD_SKIP_HOOK: '1' } });
    expect(r).toEqual({ status: 0, stderr: 'testguard: TESTGUARD_SKIP_HOOK=1, so this push was not probed', args: '' });
  });
});
