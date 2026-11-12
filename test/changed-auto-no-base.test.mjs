// #293 part 3: the pre-push hook never starts a full probe. With no base to
// compare against, `--when-no-base skip` (what the hook passes) probes nothing,
// says why in one line and exits 0; `fail` refuses (exit 2, kind no-base);
// `full`, the default, says first that every claim is probed.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { autoChangedDecision } from '../src/commands/probe.mjs';
import { project } from './helpers/scope-project.mjs';

const CI_VARS = ['GITHUB_BASE_REF', 'CI_MERGE_REQUEST_DIFF_BASE_SHA', 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME'];
const saved = Object.fromEntries(CI_VARS.map((k) => [k, process.env[k]]));
const roots = [];
afterEach(() => {
  for (const k of CI_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A repository with no remote, no upstream and no CI base: nothing for --changed auto to find. */
const noBase = () => {
  for (const k of CI_VARS) delete process.env[k];
  const p = project();
  roots.push(p.root);
  return p;
};
const run = async (args) => {
  const out = []; const err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err };
};

describe('--changed auto with no base', () => {
  it('--when-no-base skip probes nothing, says why and what to run in one line, and exits 0', async () => {
    const p = noBase();
    const r = await run(['probe', p.dir, '--runner', 'node-test', '--changed', 'auto', '--when-no-base', 'skip', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/no base to compare against.*nothing was probed.*testguard probe --changed <base-branch>/);
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });

  it('--when-no-base fail refuses with kind no-base', async () => {
    const p = noBase();
    const r = await run(['probe', p.dir, '--runner', 'node-test', '--changed', 'auto', '--when-no-base', 'fail', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error.kind).toBe('no-base');
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });

  it('by default (full), its first line says there is no base and every claim is probed', async () => {
    const p = noBase();
    const r = await run(['probe', p.dir, '--runner', 'node-test', '--changed', 'auto', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.err[0]).toMatch(/^--changed auto: no base to compare against .* so every claim is probed/);
    expect(existsSync(join(p.dir, '.testguard', 'evidence.json'))).toBe(true);
  });

  it('the option needs --changed auto and one of its three values, and skip has no JSON form', async () => {
    const p = noBase();
    expect((await run(['probe', p.dir, '--when-no-base', 'skip'])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'HEAD', '--when-no-base', 'fail'])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'auto', '--when-no-base', 'never'])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'auto', '--when-no-base', 'skip', '--json'])).code).toBe(3);
  });

  it('a base found but unresolvable is skipped or refused the same way', () => {
    const detected = { ref: 'origin/main', from: 'GITHUB_BASE_REF' };
    expect(autoChangedDecision(detected, false, 'skip')).toMatchObject({ skip: true, message: expect.stringMatching(/origin\/main .* does not resolve here.*nothing was probed/) });
    expect(autoChangedDecision(detected, false, 'fail')).toMatchObject({ refuse: true });
    expect(autoChangedDecision(detected, true, 'skip')).toMatchObject({ changed: 'origin/main' });
  });
});
