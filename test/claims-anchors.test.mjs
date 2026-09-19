// @req FR-01 FR-07 FR-15
import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAnchorLocations, checkAnchors } from '../src/claims/anchors.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const claim = (faults) => ({ id: 'C-1', statement: 'The example remains valid.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults });
const fault = (id, file, find, replace, extra = {}) => ({ id, description: id, faultClass: 'other', file, find, replace, producedBy: { producer: 'human' }, ...extra });
const doc = (faults) => ({ schemaVersion: 1, claims: [claim(faults)] });
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) } };
};

describe('claims --check-anchors: cheap preflight before a probe', () => {
  it('reports every exact anchor with hits and expected, including missing files and ambiguous text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-anchor-locations-'));
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
  });

  it('reports replacements that do not parse in JavaScript or Python, without writing either target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-anchor-syntax-'));
    const js = 'export function allowed() {\n  return true;\n}\n';
    const py = 'def allowed():\n    return True\n';
    writeFileSync(join(dir, 'a.mjs'), js);
    writeFileSync(join(dir, 'a.py'), py);
    const report = await checkAnchors(dir, doc([
      fault('JS', 'a.mjs', '  return true;', '  return (;'),
      fault('PY', 'a.py', '    return True', '    return ('),
    ]), { python: process.platform === 'win32' ? 'python' : 'python3' });
    expect(report.results).toEqual([
      expect.objectContaining({ faultId: 'JS', status: 'fault-invalid', syntax: expect.objectContaining({ language: 'javascript', status: 'invalid' }) }),
      expect.objectContaining({ faultId: 'PY', status: 'fault-invalid', syntax: expect.objectContaining({ language: 'python', status: 'invalid' }) }),
    ]);
    expect(readFileSync(join(dir, 'a.mjs'), 'utf8')).toBe(js);
    expect(readFileSync(join(dir, 'a.py'), 'utf8')).toBe(py);
  });

  it('exits 1 and names a rotted fault in both text and JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-anchor-cli-'));
    cpSync(FIXTURE, dir, { recursive: true, filter: (source) => !/node_modules|\.flake-counter|\.testguard/.test(source) });
    const path = join(dir, 'testguard.claims.json');
    const claims = JSON.parse(readFileSync(path, 'utf8'));
    claims.claims[0].faults[0].find = 'text that no longer exists';
    writeFileSync(path, JSON.stringify(claims, null, 2) + '\n');

    const json = capture();
    expect(await main(['claims', dir, '--check-anchors', '--json'], json.io)).toBe(1);
    const parsed = JSON.parse(json.lines.out.join('\n'));
    expect(parsed.anchorChecks.results).toContainEqual(expect.objectContaining({ claimId: claims.claims[0].id, status: 'anchor-missing', hits: 0, expected: 1 }));

    const text = capture();
    expect(await main(['claims', dir, '--check-anchors'], text.io)).toBe(1);
    expect(text.lines.out.join('\n')).toMatch(/ANCHOR-MISSING\s+REDACT-001\/F1.*0 hits, expected 1/);
  });

  it('checks this repository, including replacement syntax, in under one second', async () => {
    const report = await checkAnchors(ROOT, loadClaims(join(ROOT, 'testguard.claims.json')));
    expect(report.invalid).toBe(0);
    expect(report.checked).toBeGreaterThan(100);
    expect(report.durationMs).toBeLessThan(1_000);
  }, 5_000);

  it('places the failing preflight before self-probe in CI, with no failure bypass', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const preflight = workflow.indexOf('claims . --check-anchors');
    const selfProbe = workflow.indexOf('- name: probe TestGuard\'s own claims');
    expect(preflight).toBeGreaterThan(-1);
    expect(selfProbe).toBeGreaterThan(preflight);
    expect(workflow.slice(preflight, selfProbe)).not.toMatch(/continue-on-error:\s*true/);
    expect(existsSync(join(ROOT, 'src', 'claims', 'anchors.mjs'))).toBe(true);
  });
});
