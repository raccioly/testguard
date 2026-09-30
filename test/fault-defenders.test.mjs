// @req FR-17 NFR-03 NFR-06 NFR-07
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { claimsCommand, defenderNarrowing } from '../src/commands/claims.mjs';
import { main } from '../src/cli.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-fault-defenders-'));
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
  for (const n of ['a', 'b']) {
    writeFileSync(join(dir, 'src', `${n}.mjs`), `export const ${n} = () => 1;\n`);
    writeFileSync(join(dir, 'test', `${n}.test.mjs`), `import { it, expect } from 'vitest';\nimport { ${n} } from '../src/${n}.mjs';\nit('is one', () => expect(${n}()).toBe(1));\n`);
  }
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  const fault = (id, n, extra = {}) => ({ id, description: 'returns two instead of one', faultClass: 'other', file: `src/${n}.mjs`, find: '() => 1', replace: '() => 2', producedBy: { producer: 'human' }, ...extra });
  const claims = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 'Both functions return one.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, defendedBy: ['test/a.test.mjs', 'test/b.test.mjs'], faults: [fault('INHERIT', 'a'), fault('OVERRIDE', 'a', { defendedBy: ['test/a.test.mjs'] }), fault('DISCOVER', 'b', { defendedBy: [] })] }] };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, claims };
}

describe('fault-specific defenders through the operating loop', () => {
  it('measures inherited, overridden and discovered selections and refuses origin-only reuse', async () => {
    const { dir, claims } = project();
    try {
      const options = { projectDir: dir, claims, mode: 'in-place', confirmRuns: 3, budgetMs: 30_000, escalate: false };
      const ev = await probe(options);
      expect(validate('evidence', ev).errors).toEqual([]);
      expect(ev.records.map((r) => [r.subject.id, r.verdict, r.defenders.selectionSource, r.defenders.resolved])).toEqual([
        ['INHERIT', 'killed', 'claim', ['test/a.test.mjs', 'test/b.test.mjs']],
        ['OVERRIDE', 'killed', 'fault', ['test/a.test.mjs']],
        ['DISCOVER', 'killed', 'fault', ['test/b.test.mjs']],
      ]);
      expect(ev.records[2].defenders).toMatchObject({ requested: [], discovered: true });
      const reused = await probe({ ...options, previous: ev });
      expect(reused.records.every((r) => r.reusedFrom === ev.run.id)).toBe(true);
      claims.claims[0].faults[0].defendedBy = [...claims.claims[0].defendedBy];
      const changed = await probe({ ...options, previous: ev });
      expect(changed.records[0].reusedFrom).toBeUndefined();
      expect(changed.records[0].defenders.selectionSource).toBe('fault');
      expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const a = () => 1;\n');
      expect(defenderNarrowing(dir, claims, ev.records)).toEqual([]); // the narrower sets were freshly measured
      const inheritedPrior = ev.records.map((r) => ({ ...r, defenders: { requested: ['test/a.test.mjs', 'test/b.test.mjs'], resolved: ['test/a.test.mjs', 'test/b.test.mjs'], selectionSource: 'claim' } }));
      expect(defenderNarrowing(dir, claims, inheritedPrior)).toEqual([
        { claimId: 'C-1', faultId: 'OVERRIDE', inherited: ['test/a.test.mjs', 'test/b.test.mjs'], resolved: ['test/a.test.mjs'] },
        { claimId: 'C-1', faultId: 'DISCOVER', inherited: ['test/a.test.mjs', 'test/b.test.mjs'], resolved: ['test/b.test.mjs'] },
      ]);
      expect(defenderNarrowing(dir, claims, ev.records.map((r) => ({ ...r, verdict: 'survived' })))).toEqual([]);
      writeSpecDoc('evidence', join(dir, '.testguard/evidence.json'), ev);
      claims.claims[0].faults[1].defendedBy = [];
      writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
      const lines = [];
      await claimsCommand({ projectDir: dir, values: { json: true }, version: 't' }, { out: (s) => lines.push(s), err: () => {} });
      expect(JSON.parse(lines.join('\n')).narrowedDefenders.map((w) => w.faultId)).toEqual(['OVERRIDE']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('refuses a dirty override defender and a selected file the runner does not collect', async () => {
    const { dir, claims } = project();
    try {
      claims.claims[0].faults = [claims.claims[0].faults[1]];
      claims.claims[0].defendedBy = ['test/b.test.mjs'];
      writeFileSync(join(dir, 'test/a.test.mjs'), '// dirty defender\n');
      await expect(probe({ projectDir: dir, claims, mode: 'worktree' })).rejects.toThrow(/uncommitted/);
      claims.claims[0].faults[0].defendedBy = ['src/a.mjs'];
      await expect(probe({ projectDir: dir, claims, mode: 'in-place' })).rejects.toThrow(/configured runners do not collect/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('shows per-fault selections and rejects admission through an unused inherited defender', async () => {
    const { dir, claims } = project();
    try {
      const lines = [];
      await claimsCommand({ projectDir: dir, values: {}, version: 't' }, { out: (s) => lines.push(s), err: () => {} });
      expect(lines.join('\n')).toContain('C-1/OVERRIDE: fault — test/a.test.mjs');
      expect(lines.join('\n')).toContain('C-1/DISCOVER: fault (discovery) — test/b.test.mjs');
      claims.claims[0].faults = [claims.claims[0].faults[1]];
      writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
      const errors = [];
      const code = await main(['admit', join(dir, 'test/b.test.mjs'), '--claim', 'C-1', '--claims', join(dir, 'testguard.claims.json')], { out: () => {}, err: (s) => errors.push(s) });
      expect(code).toBe(3);
      expect(errors.join('\n')).toContain('not a defender of C-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
