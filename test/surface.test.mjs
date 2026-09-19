import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeClaimedSurface, needsClaimExpansion } from '../src/status/surface.mjs';

const write = (root, file, text) => {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), text);
};

const commit = (root, message) => {
  const r = spawnSync('git', ['-c', 'user.email=s@example.invalid', '-c', 'user.name=s', 'add', '-A'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const c = spawnSync('git', ['-c', 'user.email=s@example.invalid', '-c', 'user.name=s', 'commit', '-qm', message], { cwd: root, encoding: 'utf8' });
  if (c.status !== 0) throw new Error(c.stderr);
};

describe('claimed source surface', () => {
  it('names a real denominator and ranks unclaimed modules by bounded churn, with path risk separate', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-surface-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    write(root, 'src/auth/session.ts', 'export const session = 1;\n');
    write(root, 'src/claimed.ts', 'export const claimed = 1;\n');
    write(root, 'src/steady.ts', 'export const steady = 1;\n');
    write(root, 'src/feature.test.ts', 'throw new Error("not a source module");\n');
    write(root, 'src/client.generated.ts', 'export const generated = true;\n');
    commit(root, 'initial');
    write(root, 'src/auth/session.ts', 'export const session = 2;\n'); commit(root, 'auth change one');
    write(root, 'src/auth/session.ts', 'export const session = 3;\n'); commit(root, 'auth change two');

    const claims = { claims: [{ faults: [{ file: 'src/claimed.ts' }] }] };
    const surface = computeClaimedSurface({ projectDir: root, claims });
    expect(surface).toMatchObject({
      sourceModules: 3,
      claimedModules: 1,
      unclaimedModules: 2,
      history: { available: true, commitsRead: 3 },
      highChurn: { modules: 3, claimed: 1 },
    });
    expect(surface.rankedUnclaimed[0]).toEqual({ file: 'src/auth/session.ts', changes: 3, riskSignals: ['security'] });
    expect(needsClaimExpansion(surface)).toBe(true);
  });

  it('stays honest without git history and still lists concrete files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-surface-no-git-'));
    write(root, 'src/module.mjs', 'export const value = 1;\n');
    const surface = computeClaimedSurface({ projectDir: root, claims: { claims: [] } });
    expect(surface.history).toMatchObject({ available: false, commitsRead: 0 });
    expect(surface.rankedUnclaimed).toEqual([{ file: 'src/module.mjs', changes: 0, riskSignals: [] }]);
  });
});
