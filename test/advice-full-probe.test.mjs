// #301 item 7: "probes every claim on every push" names only a line that RUNS probe without --changed or --claim.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanInstalled, simpleCommands, runsFullProbe } from '../src/init/managed.mjs';
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

describe('a command is judged, not a line: message text and --help are not runs (#320)', () => {
  const scan = (hook) => {
    const dir = repo(made);
    put(dir, '.husky/pre-push', hook, 0o755);
    cfg(dir, 'core.hooksPath', '.husky/_');
    return scanInstalled({ root: dir, toolVersion: V }).filter((f) => f.reason === 'full-probe-on-push');
  };
  it('an else-branch echo, a --help check and an echo inside an if-body are not findings', () => {
    expect(scan('#!/bin/sh\nif command -v testguard >/dev/null; then :\nelse echo "  ! testguard not installed: probe skipped" >&2; exit 0; fi\n')).toEqual([]);
    expect(scan("#!/bin/sh\nif testguard probe --help | grep -q -- '--no-config'; then x=1; fi\n")).toEqual([]);
    expect(scan('#!/bin/sh\nif [ $? -ne 0 ]; then\n  echo "testguard probe did not complete; push allowed" >&2\nfi\n')).toEqual([]);
    expect(scan('#!/bin/sh\ntestguard probe --changed auto --runner-cmd "x"  # not testguard probe every claim\n')).toEqual([]);
  });
  it('a probe through a wrapper, a prefix, a shell -c, after an echo, or beside --help is still a finding', () => {
    for (const hook of [
      'TESTGUARD_RUN=1 "$@" probe --quiet',
      'testguard probe',
      'echo start; testguard probe',
      'testguard probe --help; testguard probe',
      'sh -c "testguard probe"',
      'if ! testguard probe; then exit 1; fi',
      'npx testguard-cli probe && echo ok',
    ]) expect(scan(`#!/bin/sh\n${hook}\n`), hook).toEqual([expect.objectContaining({ line: 2 })]);
  });
  it('simpleCommands splits at unquoted separators only and drops comments', () => {
    expect(simpleCommands('a "b;c" \'d|e\'; f && g | h & i\nj # k; l')).toEqual(['a "b;c" \'d|e\'', ' f ', ' g ', ' h ', ' i', 'j ']);
    expect(simpleCommands('x >&2; y 2>&1')).toEqual(['x >&2', ' y 2>&1']);
    expect(simpleCommands('echo a\\;b')).toEqual(['echo a\\;b']);
  });
  it('runsFullProbe strips keywords and assignments, and refuses echo, printf, colon, help and scoped runs', () => {
    expect(runsFullProbe('  then testguard probe')).toBe(true);
    expect(runsFullProbe('FOO="a b" BAR=1 testguard probe')).toBe(true);
    expect(runsFullProbe('FOO="testguard probe"')).toBe(false);
    for (const s of ['else echo "probe"', 'printf "probe"', ': probe', 'testguard probe -h', 'testguard probe --claim A']) expect(runsFullProbe(s), s).toBe(false);
  });
});

describe('the one-line usage error stays one line (#301 item 6)', () => {
  it('an unknown init flag is one line plus the help pointer, and exit 3', () => {
    const r = spawnSync('node', [join(import.meta.dirname, '..', 'cli', 'testguard.mjs'), 'init', '--no-such-flag'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull } });
    expect(r.status).toBe(3);
    expect(r.stderr.trim().split('\n').length).toBeLessThanOrEqual(2);
  });
});
