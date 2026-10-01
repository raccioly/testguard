// @req FR-01 FR-07 FR-15
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAnchorLocations } from '../src/claims/anchors.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const claim = (faults) => ({ id: 'C-1', statement: 'The example remains valid.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults });
const fault = (id, file, find, replace, extra = {}) => ({ id, description: id, faultClass: 'other', file, find, replace, producedBy: { producer: 'human' }, ...extra });
const doc = (faults) => ({ schemaVersion: 1, claims: [claim(faults)] });
  it('reports every exact anchor with hits and expected, including missing files and ambiguous text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-anchor-locations-'));
    try {
    writeFileSync(join(dir, 'a.mjs'), 'const same = 1;\nconst other = 1;\n');
    const report = checkAnchorLocations(dir, doc([
      fault('OK', 'a.mjs', 'const same = 1;', 'const same = 2;'),
      fault('MISSING', 'missing.mjs', 'x', 'y'),
      fault('AMBIGUOUS', 'a.mjs', '= 1;', '= 2;'),
    ]));
    expect(report).toMatchObject({ checked: 3, ok: 1, invalid: 2 });
    expect(report.results).toEqual([
      expect.objectContaining({ faultId: 'OK', status: 'ok', hits: 1, expected: 1 }),
      expect.objectContaining({ faultId: 'MISSING', status: 'anchor-missing', hits: 0, expected: 1 }),
      expect.objectContaining({ faultId: 'AMBIGUOUS', status: 'anchor-ambiguous', hits: 2, expected: 1 }),
    ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('places the failing preflight before self-probe in CI, with no failure bypass', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const preflight = workflow.indexOf('claims . --check-anchors');
    const selfProbe = workflow.indexOf('- name: probe TestGuard\'s own claims');
    expect(preflight).toBeGreaterThan(-1);
    expect(selfProbe).toBeGreaterThan(preflight);
    expect(workflow.slice(preflight, selfProbe)).not.toMatch(/continue-on-error:\s*true/);
    expect(existsSync(join(ROOT, 'src', 'claims', 'anchors.mjs'))).toBe(true);
  });