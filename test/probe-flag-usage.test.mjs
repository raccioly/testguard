// Defect D of the 0.22.1 verification: `--include-dirty --in-place` exited 2
// (a precondition) while every other incompatible pair exited 3, the documented
// usage code. The rule: a combination wrong whatever the repository holds is
// usage (3) and is refused before the repository is touched; a condition that
// depends on the tree is a precondition (2).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const run = async (args) => {
  const lines = { out: [], err: [] };
  const code = await main(args, { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) });
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
};
/** A repository that has claims but NO commit: any state-dependent refusal (no-commits) would win over a usage one if flags were checked late. */
const emptyRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-flags-'));
  roots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const fault = (id, cls, find, replace) => ({ id, description: 'd', faultClass: cls, file: 'src/x.mjs', find, replace, producedBy: { producer: 'agent', by: 'fixture' } });
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{ id: 'X-1', statement: 'x', source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy: { producer: 'agent', by: 'fixture' }, faults: [fault('F1', 'return-altered', 'a', 'b'), fault('F2', 'literal-changed', 'a', 'c')] }] }));
  return dir;
};
const quick = ['--runner', 'node-test', '--confirm', '1'];

describe('flag combinations that are wrong whatever the repository holds are usage (exit 3)', () => {
  const pairs = [
    ['--include-dirty', '--in-place'],
    ['--include-dirty', '--ref', 'HEAD'],
    ['--ref', 'HEAD', '--in-place'],
    ['--changed', 'HEAD', '--ref', 'HEAD'],
    ['--changed', 'HEAD', '--in-place'],
    ['--fault-workers', '2', '--in-place'],
    ['--partial-on-budget'],
    ['--fail-on-empty-selection'],
  ];
  for (const flags of pairs) {
    it(`${flags.join(' ')} exits 3 before the repository is looked at`, async () => {
      const dir = emptyRepo();
      const r = await run(['probe', dir, ...quick, ...flags]);
      expect(r.code, r.err).toBe(3);
      expect(existsSync(join(dir, '.testguard'))).toBe(false);
    });
  }

  it('the same flags on a real repository exit 3 too, and the message names the conflict', async () => {
    const p = project();
    roots.push(p.root);
    const r = await run(['probe', p.dir, ...quick, '--include-dirty', '--in-place']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/--include-dirty/);
    expect(r.err).toMatch(/--in-place/);
  });
});

describe('conditions that depend on the tree stay preconditions (exit 2)', () => {
  it('a repository with no commits', async () => {
    const r = await run(['probe', emptyRepo(), ...quick]);
    expect(r.code).toBe(2);
  });
  it('a ref that does not resolve', async () => {
    const p = project();
    roots.push(p.root);
    const r = await run(['probe', p.dir, ...quick, '--ref', 'no-such-ref']);
    expect(r.code).toBe(2);
  });
  it('uncommitted changes in a fault target under --in-place', async () => {
    const p = project();
    roots.push(p.root);
    writeFileSync(join(p.dir, 'src/price.mjs'), 'export const total = () => 0;\n');
    const r = await run(['probe', p.dir, ...quick, '--in-place']);
    expect(r.code).toBe(2);
  });
});
