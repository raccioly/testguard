import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { poolDrafts } from '../src/sweep/pool.mjs';
import { validate } from '../spec/lib/validate.mjs';
const roots = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'tg-placeholder-')); roots.push(dir); return dir; }
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe('unfinished generated scaffold identifiers', () => {
  it.each([
    ['guard.mjs', 'export function guard(x) {\n if (!x) return false;\n}\nexport function next(x) {\n if (!x) return false;\n}\n'],
    ['guard.py', 'def guard(x):\n    if not x:\n        return False\ndef next(x):\n    if not x:\n        return False\n'],
  ])('uses stable unfinished defaults for %s without promoting inferred intent', (file, source) => {
    const projectDir = root(), args = { projectDir, file, source };
    const { doc } = scaffoldFile(args); expect(doc.claims.map(c => c.id)).toEqual(['TODO-CLAIM-1', 'TODO-CLAIM-2']);
    expect(scaffoldFile(args).doc).toEqual(doc);
    expect(scaffoldFile({ ...args, file: 'renamed' + file.slice(file.lastIndexOf('.')) }).doc.claims.map(c => c.id)).toEqual(doc.claims.map(c => c.id));
    expect(validate('claims', doc).ok).toBe(true);
    expect(doc.claims.every(c => c.source.kind === 'inferred' && c.statement.startsWith('TODO:'))).toBe(true);
  });
  it('reserves later annotations and supplied IDs instead of copying their metadata', () => {
    const projectDir = root(), source = 'export function guard(x) {\n if (!x) return false;\n}\n// @claim TODO-CLAIM-1\nexport function next(x) {\n if (!x) return false;\n}\n';
    const base = { id: 'TODO-CLAIM-2', statement: 'Supplied unrelated intent.', source: { kind: 'spec' }, severity: 'high', producedBy: { producer: 'human' }, faults: [] };
    const { doc } = scaffoldFile({ projectDir, file: 'guard.mjs', source, existingClaims: { schemaVersion: 1, claims: [base] } });
    expect(doc.claims.map(c => c.id)).toEqual(['TODO-CLAIM-3', 'TODO-CLAIM-1']);
    expect(doc.claims[0].statement).toMatch(/^TODO:/); expect(doc.claims[0].source.kind).toBe('inferred');
    const selected = scaffoldFile({ projectDir, file: 'guard.mjs', source, claimId: base.id, existingClaims: { schemaVersion: 1, claims: [base] } });
    expect(selected.doc.claims[0].id).toBe(base.id); expect(selected.doc.claims[0].statement).toBe(base.statement);
  });
  it('pools repeated placeholder drafts without losing or changing faults', () => {
    const projectDir = root(), source = 'export function guard(x) {\n if (!x) return false;\n}\n';
    const drafts = ['left.mjs', 'right.mjs'].map(file => scaffoldFile({ projectDir, file, source }).doc);
    expect(drafts.map(d => d.claims[0].id)).toEqual(['TODO-CLAIM-1', 'TODO-CLAIM-1']);
    const pooled = poolDrafts(drafts); expect(new Set(pooled.flatMap(d => d.claims.map(c => c.id))).size).toBe(2);
    for (let i = 0; i < drafts.length; i++) expect(pooled[i].claims[0].faults).toEqual(drafts[i].claims[0].faults);
    expect(validate('claims', { schemaVersion: 1, claims: pooled.flatMap(d => d.claims) }).ok).toBe(true);
  });
});
