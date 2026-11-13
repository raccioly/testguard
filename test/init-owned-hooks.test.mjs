// #301 item 1: a hook file that already mentions TestGuard is the project's own.
// init and init --upgrade write no block beside it; the hook is EXECUTED with `sh`
// against a fake testguard to show no second probe runs and a paused one stays paused.
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from '../src/init/init.mjs';
import { handWrittenTestguard, prePushBlock } from '../src/init/managed.mjs';
import { V, cfg, hermeticRepos, put, read, repo, run } from './helpers/owned-repo.mjs';

const made = hermeticRepos();

describe('a hand-written TestGuard hook is left alone (#301 item 1)', () => {
  const FLAGS = '#!/bin/sh\necho lint\ntestguard probe --changed auto --runner-cmd "npm run unit --" --python .venv/bin/python\n';
  const PAUSED = '#!/bin/sh\n# the testguard probe is paused until the runner is fixed\nexit 0\n# testguard probe --changed auto\n';

  it('detects a mention outside a managed block, and none inside one', () => {
    expect(handWrittenTestguard(FLAGS)).toEqual({ line: 3, text: expect.stringContaining('testguard probe --changed auto') });
    expect(handWrittenTestguard(`#!/bin/sh\n${prePushBlock('.', { version: V })}\n`)).toBeNull();
    expect(handWrittenTestguard(`#!/bin/sh\n${prePushBlock('.', { version: V })}\n# TestGuard is great\n`)).toEqual({ line: expect.any(Number), text: '# TestGuard is great' });
    expect(handWrittenTestguard('#!/bin/sh\nnpm test\n')).toBeNull();
  });

  for (const [name, hook, runsOwnProbe] of [['project runner flags', FLAGS, true], ['a paused probe after an early exit 0', PAUSED, false]]) {
    for (const opts of [{}, { upgrade: true }]) {
      it(`${name}: init${opts.upgrade ? ' --upgrade' : ''} writes no block, reports it and prints the block; the hook still behaves as the owner wrote it`, () => {
        const dir = repo(made);
        put(dir, '.githooks/pre-push', hook, 0o755);
        cfg(dir, 'core.hooksPath', '.githooks');
        const r = initProject({ projectDir: dir, toolVersion: V, ...opts });
        expect(read(dir, '.githooks/pre-push')).toBe(hook); // byte for byte
        expect(r.done.join('\n')).not.toMatch(/pre-push/);
        expect(r.outdated).toContainEqual(expect.stringMatching(/^\.githooks\/pre-push:\d+: hand-written TestGuard hook: left alone/));
        expect(r.recommendations).toContainEqual({ title: expect.stringMatching(/the managed pre-push block init would have written/), lines: prePushBlock('.', { version: V }).split('\n') });
        // Executed: no second probe beside the owner's, and a paused probe is never re-enabled.
        const out = run(dir, '.githooks/pre-push');
        expect(out.calls).toEqual(runsOwnProbe ? ['probe --changed auto --runner-cmd npm run unit -- --python .venv/bin/python'] : []);
        // Re-running changes nothing either.
        initProject({ projectDir: dir, toolVersion: V, ...opts });
        expect(read(dir, '.githooks/pre-push')).toBe(hook);
      });
    }
  }

  it('--force is the only way to write the block, and it replaces nothing outside its markers', () => {
    const dir = repo(made);
    put(dir, '.githooks/pre-push', PAUSED, 0o755);
    cfg(dir, 'core.hooksPath', '.githooks');
    const r = initProject({ projectDir: dir, force: true, toolVersion: V });
    expect(r.done.join('\n')).toMatch(/pre-push: pre-push → probe --changed auto/);
    expect(read(dir, '.githooks/pre-push')).toBe(`${PAUSED}${prePushBlock('.', { version: V })}\n`);
  });

  it('a managed block beside the owner\'s own TestGuard line is not rewritten by --upgrade either', () => {
    const dir = repo(made);
    const text = `#!/bin/sh\ntestguard probe --changed auto\n${prePushBlock('.', { version: V }).replace('template=3', 'template=1')}\n`;
    put(dir, '.githooks/pre-push', text, 0o755);
    cfg(dir, 'core.hooksPath', '.githooks');
    initProject({ projectDir: dir, upgrade: true, toolVersion: V });
    expect(read(dir, '.githooks/pre-push')).toBe(text);
  });

  it('--upgrade adds no hook where TestGuard wrote none, and says so; plain init does add it', () => {
    const dir = repo(made);
    put(dir, '.githooks/pre-push', '#!/bin/sh\nnpm run lint\n', 0o755);
    cfg(dir, 'core.hooksPath', '.githooks');
    const up = initProject({ projectDir: dir, upgrade: true, toolVersion: V });
    expect(read(dir, '.githooks/pre-push')).toBe('#!/bin/sh\nnpm run lint\n');
    expect(up.skipped).toContainEqual(expect.stringMatching(/pre-push has no TestGuard block, so --upgrade adds none/));
    const none = repo(made);
    initProject({ projectDir: none, upgrade: true, toolVersion: V });
    expect(existsSync(join(none, '.githooks'))).toBe(false);
    initProject({ projectDir: dir, toolVersion: V });
    expect(read(dir, '.githooks/pre-push')).toContain('>>> testguard managed: pre-push');
  });
});

