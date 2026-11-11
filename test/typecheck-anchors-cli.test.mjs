// @req FR-01 FR-03
// Issue #236: claims --check-anchors --typecheck (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { SRC, cleanupProjects, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('claims --check-anchors --typecheck on the command line', () => {
  it('a tree that already fails the check exits 2; without --check-anchors the flag is a usage error (exit 3)', async () => {
    const dirty = stubProject({ src: SRC.replace('return x + 1;', 'return x + 1; // BAD') });
    const err = [];
    const io = { out: () => {}, err: (l) => err.push(l) };
    expect(await main(['claims', dirty, '--typecheck'], io)).toBe(3);
    expect(err.join('\n')).toMatch(/--typecheck is only valid on probe and on claims --check-anchors/);
    expect(await main(['claims', dirty, '--check-anchors', '--typecheck'], io)).toBe(2);
    expect(err.join('\n')).toMatch(/does not type-check/);
  }, 60_000);

  it('prints the first diagnostic and exits 1', async () => {
    const dir = stubProject();
    const out = [];
    expect(await main(['claims', dir, '--check-anchors', '--typecheck', '--budget', '2000'], { out: (l) => out.push(l), err: () => {} })).toBe(1);
    expect(out.join('\n')).toMatch(/FAULT-INVALID\s+BAD\/F1.*type check: src\/a\.ts\(2,3\): error TS2322: bad replacement/);
    expect(out.join('\n')).toMatch(/OK\s+OK\/F1.*type check ok/);
    expect(out.join('\n')).toMatch(/OK\s+JS\/F1.*type check not applicable/);
  }, 60_000);
});
