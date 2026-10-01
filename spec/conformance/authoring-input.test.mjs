import { describe, expect, it } from 'vitest';
import { validate, KINDS } from '../lib/validate.mjs';
import { writeSpecDoc, readSpecDoc } from '../../src/evidence/writer.mjs';

const header = { schemaVersion: 1, tool: { name: 'testguard', version: '0.0.0' }, purpose: 'authoring-input', verification: 'not-performed', next: 'supply-independent-intent' };
const document = () => ({ ...header, input: { kind: 'document', file: 'requirements.md', hash: 'a'.repeat(64), bytes: 0 } });
const row = () => ({ file: 'src/guard.mjs', status: 'M', oldMode: '100644', newMode: '100644', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), disposition: 'supported' });
const fix = () => ({ ...header, input: { kind: 'fix', commit: 'c'.repeat(40), parent: 'd'.repeat(40), subject: 'Supplied history', scope: 'project-root', paths: [row()], counts: { total: 2, supported: 1, deleted: 0, unsupported: 0, excluded: 1 } } });

describe('read-only authoring input conformance', () => {
  it('registers metadata-only document and complete fix partitions without verification', () => {
    expect(KINDS).toContain('authoring-input');
    for (const doc of [document(), fix()]) expect(validate('authoring-input', doc).errors).toEqual([]);
    const empty = fix(); empty.input.paths = []; empty.input.counts = { total: 0, supported: 0, deleted: 0, unsupported: 0, excluded: 0 };
    expect(validate('authoring-input', empty).errors).toEqual([]);
    const sha256 = fix(); sha256.input.scope = 'selected-nested-project';
    for (const field of ['commit', 'parent']) sha256.input[field] = sha256.input[field][0].repeat(64);
    for (const field of ['oldId', 'newId']) sha256.input.paths[0][field] = sha256.input.paths[0][field][0].repeat(64);
    expect(validate('authoring-input', sha256).errors).toEqual([]);
  });
  it('admits deletion and unsupported object modes without crediting supported source', () => {
    const doc = fix(); doc.input.paths[0] = { ...row(), status: 'D', newMode: '000000', newId: '0'.repeat(40), disposition: 'deleted' };
    doc.input.counts.supported = 0; doc.input.counts.deleted = 1;
    expect(validate('authoring-input', doc).errors).toEqual([]);
    doc.input.paths[0] = { ...row(), newMode: '120000', disposition: 'unsupported' };
    doc.input.counts.deleted = 0; doc.input.counts.unsupported = 1;
    expect(validate('authoring-input', doc).errors).toEqual([]);
  });
  it.each(['claims', 'source', 'verdict', 'text', 'projectDir'])('rejects promotion or internal top-level %s', field => {
    const doc = document(); doc[field] = 'not permitted'; expect(validate('authoring-input', doc).ok).toBe(false);
  });
  it.each(['source', 'text', 'identity', 'path', 'marker'])('rejects internal input %s', field => {
    const doc = document(); doc.input[field] = 'not permitted'; expect(validate('authoring-input', doc).ok).toBe(false);
  });
  it.each(['../requirements.md', '/requirements.md', 'notes//requirements.md', 'notes/./requirements.md', 'notes\\requirements.md', 'C:requirements.md', '.wolf/requirements.md', '.local/requirements.md', 'notes\u0001.md', 'guard.mjs', 'é'.repeat(2049) + '.md'])('rejects unsafe/private/unsupported document %s', file => {
    const doc = document(); doc.input.file = file; expect(validate('authoring-input', doc).ok).toBe(false);
  });
  it.each([
    ['negative bytes', d => { d.input.bytes = -1; }],
    ['oversize document', d => { d.input.bytes = 2097153; }],
    ['wrong digest', d => { d.input.hash = 'a'.repeat(40); }],
    ['optimistic verification', d => { d.verification = 'killed'; }],
    ['automatic claim next', d => { d.next = 'probe'; }],
  ])('rejects %s', (_, change) => { const doc = document(); change(doc); expect(validate('authoring-input', doc).ok).toBe(false); });
  it.each([
    ['parent width', d => { d.input.parent = 'a'.repeat(64); }],
    ['self parent', d => { d.input.parent = d.input.commit; }],
    ['row width', d => { d.input.paths[0].oldId = 'a'.repeat(64); }],
    ['unsafe subject', d => { d.input.subject = 'line\ncommand'; }],
    ['subject bytes', d => { d.input.subject = 'é'.repeat(513); }],
    ['partition denominator', d => { d.input.counts.total = 1; }],
    ['omitted row', d => { d.input.paths = []; }],
    ['duplicate row', d => { d.input.paths.push(row()); d.input.counts.total++; d.input.counts.supported++; }],
    ['private row', d => { d.input.paths[0].file = 'src/.testguard/guard.mjs'; }],
    ['noncanonical row', d => { d.input.paths[0].file = 'src//guard.mjs'; }],
    ['zero identity', d => { d.input.paths[0].oldId = '0'.repeat(40); }],
    ['wrong status', d => { d.input.paths[0].status = 'A'; }],
    ['wrong disposition', d => { d.input.paths[0].newMode = '160000'; }],
    ['wrong count bucket', d => { d.input.counts.supported = 0; d.input.counts.deleted = 1; }],
    ['unsupported extension', d => { d.input.paths[0].file = 'src/guard.txt'; }],
    ['too many paths', d => { d.input.counts.total = 257; }],
  ])('rejects %s', (_, change) => { const doc = fix(); change(doc); expect(validate('authoring-input', doc).ok).toBe(false); });
  it('uses the shared read/write validation boundary, without disk publication', () => {
    let output;
    writeSpecDoc('authoring-input', 'unused.json', document(), { publish: bytes => { output = bytes; } });
    expect(readSpecDoc('authoring-input', 'unused.json', { source: output })).toEqual(document());
    const invalid = fix(); invalid.input.counts.total = 0;
    expect(() => writeSpecDoc('authoring-input', 'unused.json', invalid, { publish: () => { throw new Error('must not publish'); } })).toThrow(/does not conform/);
    expect(() => readSpecDoc('authoring-input', 'unused.json', { source: JSON.stringify(invalid) })).toThrow(/does not conform/);
  });
  it('refuses aggregate serialization overrun even with individually bounded paths', () => {
    const doc = fix(); doc.input.paths = Array.from({ length: 256 }, (_, i) => ({ ...row(), file: `${i}-${'x'.repeat(4060)}.mjs` }));
    doc.input.counts = { total: 256, supported: 256, deleted: 0, unsupported: 0, excluded: 0 };
    expect(validate('authoring-input', doc).errors).toContainEqual({ path: '/', message: 'authoring input report exceeds byte limit' });
  });
});
