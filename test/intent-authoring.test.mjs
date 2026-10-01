import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { scaffoldCommand } from '../src/commands/scaffold.mjs';
import { computeStatus } from '../src/status/status.mjs';
import { validate } from '../spec/lib/validate.mjs';

describe('intent-first authoring is not inferred independence', () => {
  it.each([{ file: 'guard.mjs', source: '// @claim GUARD-001\nexport function guard(x) {\n  if (!x) return false;\n  return true;\n}\n' }, { file: 'guard.py', source: '# @claim GUARD-001\ndef guard(x):\n    if not x:\n        return False\n    return True\n' }])('labels mechanical $file proposals inferred even with an annotation', ({ file, source }) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tg-intent-'));
    writeFileSync(join(projectDir, file), source);
    const { doc } = scaffoldFile({ projectDir, file });
    expect(doc.claims.length).toBeGreaterThan(0);
    expect(validate('claims', doc).errors).toEqual([]);
    for (const claim of doc.claims) {
      expect(claim.source.kind).toBe('inferred');
      expect(claim.producedBy.producer).toBe('derived');
      expect(claim.statement).toMatch(/^TODO:.*intended observable behavior/);
      expect(claim.statement).toContain('requirement, ADR, bug or incident');
    }
  });

  it('retains independently supplied metadata without promoting proposals', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tg-intent-'));
    writeFileSync(join(projectDir, 'guard.mjs'), 'export function guard(x) {\n  if (!x) return false;\n}\n');
    const base = { id: 'GUARD-001', statement: 'Absent credentials must be rejected.', source: { kind: 'incident', ref: 'opaque:incident-1' }, producedBy: { producer: 'human' }, severity: 'critical', tags: ['access'], defendedBy: ['guard.test.mjs'], faults: [] };
    const existingClaims = { schemaVersion: 1, claims: [base] };
    const before = JSON.stringify(existingClaims);
    const { doc } = scaffoldFile({ projectDir, file: 'guard.mjs', claimId: base.id, existingClaims });
    const { faults, ...metadata } = doc.claims[0];
    const { faults: ignored, ...expected } = base;
    expect(metadata).toEqual(expected);
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((f) => f.producedBy.producer === 'derived')).toBe(true);
    expect(JSON.stringify(existingClaims)).toBe(before);
  });

  it('hands off intent explicitly in human CLI and no-claims status without changing next', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tg-intent-'));
    const file = join(projectDir, 'guard.mjs');
    writeFileSync(file, 'export function guard(x) {\n  if (!x) return false;\n}\n');
    const lines = [];
    expect(await scaffoldCommand({ projectDir, file, values: {}, version: 'test' }, { out: (s) => lines.push(s), err: (s) => lines.push(s) })).toBe(0);
    expect(lines.join('\n')).toContain('keep inferred');
    expect(lines.join('\n')).toContain('independently of the implementation');
    expect(lines.join('\n')).toContain('not authenticated');
    const status = computeStatus({ projectDir });
    expect(validate('status', status).errors).toEqual([]);
    expect(status.state).toBe('no-claims');
    expect(status.next.action).toBe('scaffold');
    expect(status.next.why).toContain('intended observable behavior');
    expect(status.next.why).toContain('keep inferred');
    expect(status.next.why).toContain('independently of the implementation');
  });
});
