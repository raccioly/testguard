import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function dirtyRepo(defender = 'test/a.test.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'tg-dirty-paths-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
  writeFileSync(join(dir, defender), "import { a } from '../src/a.mjs';\n");
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  git('add', '-A');
  git('commit', '-qm', 'one');
  writeFileSync(join(dir, defender), "import { a } from '../src/a.mjs';\n// uncommitted\n");
  const claims = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 's', source: { kind: 'manual' }, severity: 'low', producedBy: { producer: 'human' }, defendedBy: [defender],
    faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } }] }] };
  return { dir, claims };
}

describe('dirty preflight path parsing', () => {
  it('refuses Git-quoted dirty paths containing spaces and non-ASCII characters', async () => {
    const { dir, claims } = dirtyRepo('test/a b-é.test.mjs');
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', toolVersion: 't' }))
      .rejects.toThrow(/test\/a b-é\.test\.mjs/);
  });

  it('refuses both sides of a dirty defender rename from NUL-delimited status', async () => {
    const { dir, claims } = dirtyRepo();
    const renamed = join(dir, 'test', 'a renamed.test.mjs');
    writeFileSync(renamed, "import { a } from '../src/a.mjs';\n// renamed while dirty\n");
    spawnSync('git', ['rm', '-q', 'test/a.test.mjs'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['add', 'test/a renamed.test.mjs'], { cwd: dir, encoding: 'utf8' });
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', toolVersion: 't' }))
      .rejects.toThrow(/test\/a\.test\.mjs|test\/a renamed\.test\.mjs/);
  });
});
