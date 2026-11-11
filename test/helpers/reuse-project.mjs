// A throwaway project for the verdict-reuse tests of #232: a target that
// imports a helper, a node:test defender that also READS a data file (an input
// no hash covers), and one claim over the target.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

export const git = (dir, ...args) => execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
export const commit = (dir) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'step'); };

export const HELPER = 'export function round(x) {\n  return Math.round(x * 100) / 100;\n}\n';
export const PRICE = "import { round } from './helper.mjs';\n\nexport function total(a, b) {\n  return round(a + b);\n}\n";
export const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { total } from '../src/price.mjs';

test('total adds and rounds', () => {
  const expected = JSON.parse(readFileSync(new URL('../data/expected.json', import.meta.url), 'utf8'));
  assert.equal(total(1, 2), expected.sum);
});
`;
export const CLAIMS = {
  schemaVersion: 1,
  claims: [{
    id: 'PRICE-TOTAL',
    statement: 'A total is the rounded sum of its parts.',
    source: { kind: 'spec', ref: 'README.md' },
    severity: 'high',
    producedBy: { producer: 'agent', by: 'fixture' },
    defendedBy: ['test/price.test.mjs'],
    faults: [{ id: 'F1', description: 'Subtract instead of add.', faultClass: 'other', file: 'src/price.mjs', find: 'return round(a + b);', replace: 'return round(a - b);', producedBy: { producer: 'agent', by: 'fixture' } }],
  }],
};

export function project({ price = PRICE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-reuse-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reuse-fixture', private: true, type: 'module' }));
  writeFileSync(join(dir, 'src/helper.mjs'), HELPER);
  writeFileSync(join(dir, 'src/price.mjs'), price);
  writeFileSync(join(dir, 'test/price.test.mjs'), TEST);
  writeFileSync(join(dir, 'data/expected.json'), JSON.stringify({ sum: 3 }));
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(CLAIMS));
  git(dir, 'init', '-q');
  commit(dir);
  return dir;
}

export const options = (dir, previous) => ({ projectDir: dir, claims: CLAIMS, runnerName: 'node-test', confirmRuns: 3, budgetMs: 10_000, mode: 'worktree', toolVersion: 'test', ...(previous ? { previous } : {}) });

