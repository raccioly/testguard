import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A one-claim repo whose defender exists but has an uncommitted edit. The refusal cases never invoke a runner; the honoured cases do, so the project's node_modules is linked in. */
function dirtyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-precond-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
  writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n");
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir'); // the honoured cases run vitest; CI has no npx cache to fall back on
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
  it('an explicit --ref (even HEAD) is honoured over a dirty defender: a warning names the files and the evidence records them; --ignore-dirty does the same for the implicit HEAD', async () => {
    const { dir, claims } = dirtyRepo();
    const warnings = [];
    const ev = await probe({ projectDir: dir, claims, mode: 'worktree', ref: 'HEAD', refExplicit: true, confirmRuns: 1, budgetMs: 30_000, escalate: false, toolVersion: 't', onWarn: (m) => warnings.push(m) });
    // The suite itself runs under vitest, so the contention detector legitimately
    // warns too; assert on the dirty-tree warning rather than on the count.
    const dirtyWarnings = warnings.filter((w) => /uncommitted changes/.test(w));
    expect(dirtyWarnings).toHaveLength(1);
    expect(dirtyWarnings[0]).toMatch(/test\/a\.test\.mjs.*probing HEAD \([a-f0-9]{7}\) as committed.*NOT what is being probed/s);
    expect(ev.run.repo.ignoredDirty).toEqual(['test/a.test.mjs']);
    expect(ev.run.repo.snapshot).toBeUndefined();
    const again = [];
    const ev2 = await probe({ projectDir: dir, claims, mode: 'worktree', ignoreDirty: true, confirmRuns: 1, budgetMs: 30_000, escalate: false, toolVersion: 't', onWarn: (m) => again.push(m) });
    expect(again.filter((w) => /uncommitted changes/.test(w))).toHaveLength(1);
    expect(ev2.run.repo.ignoredDirty).toEqual(['test/a.test.mjs']);
    // and the contention it saw is on the evidence, so a later reader of a slow run knows
    if (ev2.run.contention) expect(ev2.run.contention.runners.length).toBeGreaterThan(0);
    // the implicit HEAD without --ignore-dirty is still refused (the message now offers --ignore-dirty)
    await expect(probe({ projectDir: dir, claims, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(/--ignore-dirty/);
  }, 120_000);
});
