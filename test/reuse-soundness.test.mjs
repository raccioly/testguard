// Issue #232: a reused verdict must be about the code the defenders run today.
// Reuse compared the target and defender files only, so breaking a helper the
// target imports carried a prior `killed` forward over a red suite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { computeStatus } from '../src/status/status.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const git = (dir, ...args) => execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
const commit = (dir) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'step'); };

const HELPER = 'export function round(x) {\n  return Math.round(x * 100) / 100;\n}\n';
const PRICE = "import { round } from './helper.mjs';\n\nexport function total(a, b) {\n  return round(a + b);\n}\n";
const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { total } from '../src/price.mjs';

test('total adds and rounds', () => {
  const expected = JSON.parse(readFileSync(new URL('../data/expected.json', import.meta.url), 'utf8'));
  assert.equal(total(1, 2), expected.sum);
});
`;
const CLAIMS = {
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

function project({ price = PRICE } = {}) {
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

const options = (dir, previous) => ({ projectDir: dir, claims: CLAIMS, runnerName: 'node-test', confirmRuns: 3, budgetMs: 10_000, mode: 'worktree', toolVersion: 'test', ...(previous ? { previous } : {}) });

describe('verdict reuse is bound to what the target and defenders import (#232)', () => {
  let dir;
  let first;
  beforeEach(async () => {
    dir = project();
    first = await probe(options(dir));
    expect(first.records[0].verdict).toBe('killed');
  }, 30_000);
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('records the import closure of the target and its defenders as complete', () => {
    const { inputs } = first.records[0];
    expect(inputs.dependencyClosure).toBe('complete');
    expect(Object.keys(inputs.dependencyHashes)).toEqual(expect.arrayContaining(['src/helper.mjs', 'src/price.mjs', 'test/price.test.mjs', 'package.json']));
    expect(validate('evidence', first).errors).toEqual([]);
  });

  it('a helper broken so the defender goes red is neither reused nor killed', async () => {
    writeFileSync(join(dir, 'src/helper.mjs'), 'export function round(x) {\n  return Number.NaN;\n}\n');
    commit(dir);
    const second = await probe(options(dir, first));
    const record = second.records[0];
    expect(record.reusedFrom).toBeUndefined();
    expect(record.verdict).not.toBe('killed');
    expect(record.verdict).toBe('flaky-defender');
  }, 30_000);

  it('a helper changed while the defender stays green is re-measured, not reused', async () => {
    writeFileSync(join(dir, 'src/helper.mjs'), 'export function round(x) {\n  return Math.round(x * 1000) / 1000;\n}\n');
    commit(dir);
    const second = await probe(options(dir, first));
    const record = second.records[0];
    expect(record.reusedFrom).toBeUndefined();
    expect(record.verdict).toBe('killed');
    expect(record.detail.probeRuns).toHaveLength(3);
  }, 30_000);

  it('runs one live baseline before reusing, and that run is measured', async () => {
    const second = await probe(options(dir, first));
    expect(second.records[0].reusedFrom).toBe(first.run.id);
    expect(second.run.measurements.runnerInvocations).toBe(1);
    expect(second.run.measurements.reuseBaselineRuns).toBe(1);
    expect(validate('evidence', second).errors).toEqual([]);
  }, 30_000);

  it('a defender red for a reason no hash covers is neither reused nor killed', async () => {
    // data/expected.json is read, never imported: outside every hash.
    writeFileSync(join(dir, 'data/expected.json'), JSON.stringify({ sum: 4 }));
    commit(dir);
    const second = await probe(options(dir, first));
    const record = second.records[0];
    expect(record.reusedFrom).toBeUndefined();
    expect(record.verdict).not.toBe('killed');
    expect(record.verdict).toBe('flaky-defender');
  }, 30_000);

  it('legacy evidence without dependencyHashes stays valid and is never reused', async () => {
    const legacy = structuredClone(first);
    for (const record of legacy.records) { delete record.inputs.dependencyHashes; delete record.inputs.dependencyClosure; }
    expect(validate('evidence', legacy).errors).toEqual([]);
    const second = await probe(options(dir, legacy));
    expect(second.records[0].reusedFrom).toBeUndefined();
    expect(second.records[0].verdict).toBe('killed');
  }, 30_000);

  it('status reports a changed import as stale', () => {
    mkdirSync(join(dir, '.testguard'), { recursive: true });
    writeFileSync(join(dir, '.testguard/evidence.json'), JSON.stringify(first));
    expect(computeStatus({ projectDir: dir }).stale).toEqual([]);
    writeFileSync(join(dir, 'src/helper.mjs'), 'export function round(x) {\n  return x;\n}\n');
    const { stale, state } = computeStatus({ projectDir: dir });
    expect(state).toBe('evidence-stale');
    expect(stale.some((line) => line.startsWith('src/helper.mjs changed since PRICE-TOTAL/F1'))).toBe(true);
  });
});

describe('an import closure that cannot be followed is never reusable (#232)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a computed dynamic import keeps the fault re-measured on every probe', async () => {
    const computed = "import { round } from './helper.mjs';\nconst name = './helper' + '.mjs';\nexport const lazy = () => import(name);\n\nexport function total(a, b) {\n  return round(a + b);\n}\n";
    dir = project({ price: computed });
    const first = await probe(options(dir));
    expect(first.records[0].inputs.dependencyClosure).toBe('indeterminate');
    expect(first.records[0].inputs.dependencyIssues).toEqual([{ code: 'computed-specifier', file: 'src/price.mjs' }]);
    const second = await probe(options(dir, first));
    expect(second.records[0].reusedFrom).toBeUndefined();
    expect(second.records[0].verdict).toBe('killed');
    expect(second.records[0].detail.probeRuns).toHaveLength(3);
  }, 30_000);
});
