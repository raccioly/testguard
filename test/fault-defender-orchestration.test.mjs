// @req FR-17 NFR-03 NFR-06 NFR-07
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';

it('kills a fault with its override, not the unrelated inherited defender', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-focused-defender-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    for (const name of ['a', 'b']) {
      writeFileSync(join(dir, 'src', `${name}.mjs`), `export const ${name} = () => 1;\n`);
      writeFileSync(join(dir, 'test', `${name}.test.mjs`), `import { it, expect } from 'vitest';\nimport { ${name} } from '../src/${name}.mjs';\nit('is one', () => expect(${name}()).toBe(1));\n`);
    }
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) {
      const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const claims = { schemaVersion: 1, claims: [{
      id: 'C-1', statement: 'The first function returns one.', severity: 'high',
      source: { kind: 'manual' }, producedBy: { producer: 'human' },
      // This test does not import the target: using it would leave the fault alive.
      defendedBy: ['test/b.test.mjs'],
      faults: [{ id: 'F1', description: 'returns two instead of one', faultClass: 'other',
        file: 'src/a.mjs', find: '() => 1', replace: '() => 2',
        defendedBy: ['test/a.test.mjs'], producedBy: { producer: 'human' } }],
    }] };
    const evidence = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 3, budgetMs: 30_000, escalate: false });
    expect(validate('evidence', evidence).errors).toEqual([]);
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]).toMatchObject({ verdict: 'killed', defenders: {
      requested: ['test/a.test.mjs'], resolved: ['test/a.test.mjs'], selectionSource: 'fault',
    } });
    expect(readFileSync(join(dir, 'src/a.mjs'), 'utf8')).toBe('export const a = () => 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
