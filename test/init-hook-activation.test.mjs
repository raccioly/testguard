// #301 item 9: is the hook init wrote one this clone's git runs? A finding with the fix when it is not;
// the wrapper and the managed block are EXECUTED, through a real `git push` as well.
import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/init/init.mjs';
import { hookActivation, wrapperScript } from '../src/init/activation.mjs';
import { prePushBlock } from '../src/init/managed.mjs';
import { hookAdvice } from '../src/status/advice.mjs';
import { V, cfg, devNull, git, hermeticRepos, put, read, repo, run } from './helpers/owned-repo.mjs';

const made = hermeticRepos();

describe('the hook init wrote is on the active hooks path, or init says how to put it there (#301 item 9)', () => {
  const hookFile = (dir) => join(dir, '.githooks/pre-push');
  const fresh = () => { const dir = repo(made); put(dir, '.githooks/pre-push', `#!/bin/sh\n${prePushBlock('.', { version: V })}\n`, 0o755); return dir; };

  it('core.hooksPath at the hook directory: active', () => {
    const dir = fresh();
    cfg(dir, 'core.hooksPath', '.githooks');
    expect(hookActivation({ root: dir, hookFile: hookFile(dir) })).toMatchObject({ active: true, how: 'core.hooksPath' });
  });

  it('nothing in .git/hooks: recommends core.hooksPath, and --activate-hook sets it', () => {
    const dir = fresh();
    const a = hookActivation({ root: dir, hookFile: hookFile(dir) });
    expect(a).toMatchObject({ active: false, kind: 'config', command: 'git config core.hooksPath .githooks' });
    const r = initProject({ projectDir: dir, toolVersion: V });
    expect(cfg(dir, '--get', 'core.hooksPath').stdout).toBe(''); // init alone changes no git config
    expect(r.outdated).toContainEqual(expect.stringMatching(/pre-push:1: is not on this clone's active hooks path, so it never runs on push — git config core\.hooksPath \.githooks/));
    const act = initProject({ projectDir: dir, activateHook: true, toolVersion: V });
    expect(act.done).toContainEqual(expect.stringMatching(/^git config core\.hooksPath \.githooks/));
    expect(cfg(dir, '--get', 'core.hooksPath').stdout.trim()).toBe('.githooks');
    expect(initProject({ projectDir: dir, toolVersion: V }).outdated).toEqual([]);
  });

  it('other hooks in .git/hooks: recommends a wrapper that keeps them, never repointing core.hooksPath', () => {
    const dir = fresh();
    put(dir, '.git/hooks/post-commit', '#!/bin/sh\necho committed\n', 0o755);
    put(dir, '.git/hooks/prepare-commit-msg.sample', '#!/bin/sh\n', 0o755); // samples are not hooks
    const r = initProject({ projectDir: dir, toolVersion: V });
    const rec = r.recommendations.find((x) => /not on the active hooks path/.test(x.title));
    expect(rec.title).toMatch(/keep the other hooks, call this one/);
    expect(rec.lines.join('\n')).toContain('exec sh "$hook" "$@"');
    expect(rec.lines.join('\n')).toContain('post-commit');
    expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(false); // printed, not written
    expect(cfg(dir, '--get', 'core.hooksPath').stdout).toBe('');
    // --activate-hook writes it; the other hook is untouched; git now finds the hook.
    const act = initProject({ projectDir: dir, activateHook: true, toolVersion: V });
    expect(act.done).toContainEqual(expect.stringMatching(/^\.git\/hooks\/pre-push: calls \.githooks\/pre-push; the other hooks there are untouched/));
    expect(read(dir, '.git/hooks/post-commit')).toBe('#!/bin/sh\necho committed\n');
    expect(read(dir, '.git/hooks/pre-push')).toBe(wrapperScript('.githooks/pre-push'));
    expect(hookActivation({ root: dir, hookFile: hookFile(dir) })).toMatchObject({ active: true });
    expect(initProject({ projectDir: dir, toolVersion: V }).outdated).toEqual([]);
  });

  it('the wrapper, executed: passes the push arguments and stdin through, keeps the exit status, and is silent when the tracked file is gone', () => {
    const dir = repo(made);
    put(dir, '.githooks/pre-push', '#!/bin/sh\necho "args:$*" >&2\ncat > "$(git rev-parse --show-toplevel)/stdin.txt"\nexit 7\n', 0o755);
    put(dir, '.git/hooks/pre-push', wrapperScript('.githooks/pre-push'), 0o755);
    const r = spawnSync('sh', ['.git/hooks/pre-push', 'origin', 'url'], { cwd: dir, input: 'refs/heads/main abc refs/heads/main def\n', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: devNull } });
    expect(r.status).toBe(7);
    expect(r.stderr).toBe('args:origin url\n');
    expect(read(dir, 'stdin.txt')).toBe('refs/heads/main abc refs/heads/main def\n');
    rmSync(join(dir, '.githooks'), { recursive: true });
    expect(spawnSync('sh', ['.git/hooks/pre-push'], { cwd: dir, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: devNull } }).status).toBe(0);
  });

  it('the wrapper runs the managed block through a real `git push` hook call', () => {
    const dir = fresh();
    put(dir, '.git/hooks/post-commit', '#!/bin/sh\n', 0o755);
    initProject({ projectDir: dir, activateHook: true, toolVersion: V });
    const bin = mkdtempSync(join(tmpdir(), 'tg-owned-bin-'));
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'testguard'), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${V}; exit 0; fi\necho "$*" >> "${log}"\nexit 1\n`);
    chmodSync(join(bin, 'testguard'), 0o755);
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'tg-owned-remote-')));
    made.push(remote, bin);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'c');
    git(dir, 'remote', 'add', 'origin', remote);
    // FIXTURE_GIT pins core.hooksPath to /dev/null for fixtures; this call WANTS the clone's own hooks, so it builds its own argv.
    const push = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(readFileSync(log, 'utf8').trim()).toBe('probe --changed auto --when-no-base skip --quiet');
    expect(push.status).not.toBe(0); // the fake probe exits 1 (unproven): the hook refused the push
  });

  it('a pre-push already in .git/hooks is never edited: a one-line fix is printed, and --activate-hook leaves it', () => {
    const dir = fresh();
    const theirs = '#!/bin/sh\necho theirs\n';
    put(dir, '.git/hooks/pre-push', theirs, 0o755);
    const a = hookActivation({ root: dir, hookFile: hookFile(dir) });
    expect(a).toMatchObject({ active: false, kind: 'call' });
    expect(a.fix).toContain('sh "$(git rev-parse --show-toplevel)/.githooks/pre-push" "$@" || exit 1');
    const r = initProject({ projectDir: dir, activateHook: true, toolVersion: V });
    expect(read(dir, '.git/hooks/pre-push')).toBe(theirs);
    expect(r.warnings.join('\n')).toMatch(/--activate-hook left it: \.git\/hooks\/pre-push exists and does not call/);
    // Once their hook calls it, it is active.
    put(dir, '.git/hooks/pre-push', `${theirs}sh "$(git rev-parse --show-toplevel)/.githooks/pre-push" "$@" || exit 1\n`, 0o755);
    expect(hookActivation({ root: dir, hookFile: hookFile(dir) })).toMatchObject({ active: true });
  });

  it('core.hooksPath elsewhere: say where to call it from; nothing is changed', () => {
    const dir = fresh();
    cfg(dir, 'core.hooksPath', 'tools/hooks');
    const a = hookActivation({ root: dir, hookFile: hookFile(dir) });
    expect(a).toMatchObject({ active: false, kind: 'call' });
    expect(a.fix).toMatch(/core\.hooksPath is tools\/hooks, not \.githooks: add this line to tools\/hooks\/pre-push/);
    expect(cfg(dir, '--get', 'core.hooksPath').stdout.trim()).toBe('tools/hooks');
  });

  it('husky: active when husky owns core.hooksPath, a finding with its own fix when it does not', () => {
    const dir = repo(made);
    put(dir, '.husky/pre-push', `#!/bin/sh\n${prePushBlock('.', { version: V })}\n`, 0o755);
    expect(hookActivation({ root: dir, hookFile: join(dir, '.husky/pre-push') })).toMatchObject({ active: false, kind: 'husky' });
    cfg(dir, 'core.hooksPath', '.husky/_');
    expect(hookActivation({ root: dir, hookFile: join(dir, '.husky/pre-push') })).toMatchObject({ active: true, how: 'husky' });
  });

  it('from a linked worktree: the shared .git/hooks is where the wrapper goes, and it runs from there', () => {
    const main = repo(made, { commit: true });
    put(main, '.git/hooks/post-checkout', '#!/bin/sh\n', 0o755);
    const wt = join(main, '..', `${main.split('/').pop()}-wt`);
    made.push(wt);
    expect(git(main, 'worktree', 'add', '-q', wt, '-b', 'feature').status).toBe(0);
    const root = realpathSync(wt);
    put(root, '.githooks/pre-push', `#!/bin/sh\n${prePushBlock('.', { version: V })}\n`, 0o755);
    const a = hookActivation({ root, hookFile: join(root, '.githooks/pre-push') });
    expect(a).toMatchObject({ active: false, kind: 'wrapper' });
    expect(a.hooksDir).toBe(join(main, '.git/hooks'));
    const r = initProject({ projectDir: root, activateHook: true, toolVersion: V });
    expect(r.done).toContainEqual(expect.stringMatching(/pre-push: calls \.githooks\/pre-push/));
    expect(read(main, '.git/hooks/pre-push')).toBe(wrapperScript('.githooks/pre-push'));
    // Run from the worktree, the wrapper finds the worktree's own tracked file and the managed block runs.
    const out = run(root, join(main, '.git/hooks/pre-push'));
    expect(out.status).toBe(0);
    expect(out.calls).toEqual(['probe --changed auto --when-no-base skip --quiet']);
    expect(hookActivation({ root, hookFile: join(root, '.githooks/pre-push') })).toMatchObject({ active: true });
  });

  it('status advice names an inactive hook with the command that turns it on, and is quiet once active', () => {
    const dir = fresh();
    const advice = hookAdvice({ root: dir, toolVersion: V });
    expect(advice).toEqual([{ id: 'hook-outdated', message: expect.stringMatching(/^\.githooks\/pre-push:1: is not on this clone's active hooks path, so it never runs on push — git config core\.hooksPath \.githooks/), command: 'testguard init --activate-hook' }]);
    cfg(dir, 'core.hooksPath', '.githooks');
    expect(hookAdvice({ root: dir, toolVersion: V })).toEqual([]);
  });
});

