// Issue #232: `status` applies the same dependency closure and comparison as
// verdict reuse, so a changed import is stale exactly when a probe would
// re-measure it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../src/probe/probe.mjs';
import { computeStatus } from '../src/status/status.mjs';
import { options, project } from './helpers/reuse-project.mjs';

describe('status staleness follows the import closure (#232)', () => {
  let dir;
  let first;
  beforeAll(async () => {
    dir = project();
    first = await probe(options(dir));
  }, 30_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reports a changed import as stale, and nothing when it is unchanged', () => {
    mkdirSync(join(dir, '.testguard'), { recursive: true });
    writeFileSync(join(dir, '.testguard/evidence.json'), JSON.stringify(first));
    expect(computeStatus({ projectDir: dir }).stale).toEqual([]);
    writeFileSync(join(dir, 'src/helper.mjs'), 'export function round(x) {\n  return x;\n}\n');
    const { stale, state } = computeStatus({ projectDir: dir });
    expect(state).toBe('evidence-stale');
    expect(stale.some((line) => line.startsWith('src/helper.mjs changed since PRICE-TOTAL/F1'))).toBe(true);
  });

  it('reports evidence written before dependency hashing as stale once', () => {
    const legacy = structuredClone(first);
    for (const record of legacy.records) { delete record.inputs.dependencyHashes; delete record.inputs.dependencyClosure; }
    writeFileSync(join(dir, '.testguard/evidence.json'), JSON.stringify(legacy));
    expect(computeStatus({ projectDir: dir }).stale).toContain('PRICE-TOTAL/F1 predates dependency hashing and cannot be reused');
  });
});
