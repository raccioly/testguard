// #301 item 7: "probes every claim on every push" names only a line that RUNS probe without --changed or --claim.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanInstalled } from '../src/init/managed.mjs';
import { V, cfg, devNull, hermeticRepos, put, repo } from './helpers/owned-repo.mjs';

const made = hermeticRepos();

describe('"probes every claim on every push" names only a line that runs probe without --changed or --claim (#301 item 7)', () => {
  const scan = (hook) => {
    const dir = repo(made);
    put(dir, '.husky/pre-push', hook, 0o755);
    cfg(dir, 'core.hooksPath', '.husky/_');
    return scanInstalled({ root: dir, toolVersion: V }).filter((f) => f.reason === 'full-probe-on-push');
  };
  it('a probe continued over lines, with --changed on the next one, is not a finding', () => {
    expect(scan('#!/bin/sh\ntestguard probe \\\n  --changed auto --runner-cmd "npm run unit --"\n')).toEqual([]);
    expect(scan('#!/bin/sh\nnpx testguard probe --changed auto --runner-cmd "x"\n')).toEqual([]);
    expect(scan('#!/bin/sh\ntestguard probe --claim A-1\n')).toEqual([]);
  });
  it('a comment, an echo and a printf that mention probing every claim are not findings', () => {
    expect(scan('#!/bin/sh\n# testguard: this hook used to probe every claim; now it probes only the change\necho "testguard probe every claim is the nightly job"\nprintf "testguard probe\\n"\n  # testguard probe\n')).toEqual([]);
  });
  it('a command that runs probe with neither flag is still one, also when continued', () => {
    expect(scan('#!/bin/sh\ntestguard probe\n')).toEqual([expect.objectContaining({ line: 2 })]);
    expect(scan('#!/bin/sh\nnpx testguard probe . \\\n  --confirm 3\n')).toEqual([expect.objectContaining({ line: 2 })]);
  });
});

describe('the one-line usage error stays one line (#301 item 6)', () => {
  it('an unknown init flag is one line plus the help pointer, and exit 3', () => {
    const r = spawnSync('node', [join(import.meta.dirname, '..', 'cli', 'testguard.mjs'), 'init', '--no-such-flag'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull } });
    expect(r.status).toBe(3);
    expect(r.stderr.trim().split('\n').length).toBeLessThanOrEqual(2);
  });
});
