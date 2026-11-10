// Issue #232: a reused verdict must be about the code the defenders run today.
// Reuse compared the target and defender files only, so breaking a helper the
// target imports carried a prior `killed` forward over a red suite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, options, project } from './helpers/reuse-project.mjs';

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

  it('evidence written by another TestGuard version is readable and never reused', async () => {
    const older = structuredClone(first);
    older.tool.version = 'older';
    older.run.instrument.toolVersion = 'older';
    expect(validate('evidence', older).errors).toEqual([]);
    const second = await probe(options(dir, older));
    expect(second.records[0].reusedFrom).toBeUndefined();
    expect(second.records[0].verdict).toBe('killed');
    expect(second.run.instrument).toEqual({ toolVersion: 'test', digest: first.run.instrument.digest });
    expect(second.run.reuse).toEqual({ reused: 0, measured: 1 });
  }, 30_000);

  it('legacy evidence without dependencyHashes stays valid and is never reused', async () => {
    const legacy = structuredClone(first);
    for (const record of legacy.records) { delete record.inputs.dependencyHashes; delete record.inputs.dependencyClosure; }
    expect(validate('evidence', legacy).errors).toEqual([]);
    const second = await probe(options(dir, legacy));
    expect(second.records[0].reusedFrom).toBeUndefined();
    expect(second.records[0].verdict).toBe('killed');
  }, 30_000);

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
