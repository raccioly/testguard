import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';

/** A one-claim repo whose defender exists but has an uncommitted edit. Fast: no runner is ever invoked. */
function dirtyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-precond-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
  writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n");
  g('add', '-A');
  g('commit', '-qm', 'one');
  writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n// uncommitted\n");
  const claims = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 's', source: { kind: 'manual' }, severity: 'low', producedBy: { producer: 'human' }, defendedBy: ['test/a.test.mjs'],
    faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } }] }] };
  return { dir, claims };
}

describe('probe preconditions', () => {
  it('worktree mode refuses a dirty defender, naming the file (with its full path) and the commit', async () => {
    const { dir, claims } = dirtyRepo();
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(PreconditionError);
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(/\(test\/a\.test\.mjs\).*probes HEAD \([a-f0-9]{7}\).*--include-dirty/s);
  });
  it('--include-dirty cannot be combined with --in-place or --ref', async () => {
    const { dir, claims } = dirtyRepo();
    await expect(probe({ projectDir: dir, claims, mode: 'in-place', includeDirty: true, toolVersion: 't' })).rejects.toThrow(/--include-dirty applies to worktree mode/);
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', includeDirty: true, ref: 'HEAD~0', toolVersion: 't' })).rejects.toThrow(/cannot be combined with --ref/);
  });
});
