import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAnnotationPlacement, revalidateAnnotationPlan } from '../src/claims/annotation-placement.mjs';

const reads = vi.hoisted(() => ({ bytes: null }));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs, readSync: (...args) => {
    const count = fs.readSync(...args);
    if (reads.bytes !== null) reads.bytes += count;
    return count;
  } };
});

const roots = [];
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-annotation-plan-'));
  roots.push(root); mkdirSync(join(root, 'src')); return root;
};
afterEach(() => { reads.bytes = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fault = (file, find = 'return true;', extra = {}) => ({ id: 'F1', description: 'Remove the required result.', faultClass: 'other', file, find, replace: 'return false;', producedBy: { producer: 'human' }, ...extra });
const claim = (id, faults) => ({ id, statement: 'The required result is true.', severity: 'high', source: { kind: 'spec' }, producedBy: { producer: 'human' }, faults });
const doc = (...claims) => ({ schemaVersion: 1, claims });
const source = 'export function allowed() { return true; }\n';

describe('annotation placement planning — read-only, file-level authoring', () => {
  it('groups multiple faults and claims by target without changing source or claim metadata', () => {
    const root = project(); writeFileSync(join(root, 'src/a.mjs'), source);
    const claims = doc(claim('Z-1', [fault('src/a.mjs'), fault('src/a.mjs', 'allowed()', { id: 'F2', replace: 'denied()' })]), claim('A-1', [fault('src/a.mjs')]));
    const before = JSON.stringify(claims);
    const plan = planAnnotationPlacement({ projectDir: root, claims });
    expect(plan.refused).toEqual([]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ file: 'src/a.mjs', claimIds: ['A-1', 'Z-1'], changed: true, proposed: '// @claim A-1\n// @claim Z-1\n' + source });
    expect(plan.claimsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.files[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(root, 'src/a.mjs'), 'utf8')).toBe(source);
    expect(JSON.stringify(claims)).toBe(before);
  });

  it.each([
    ['src/a.mjs', '\uFEFF#!/usr/bin/env node\r\n' + source.replaceAll('\n', '\r\n'), '\uFEFF#!/usr/bin/env node\r\n// @claim A-1\r\n'],
    ['src/a.py', '#!/usr/bin/env python3\n# coding: utf-8\ndef allowed(): return true;\n', '#!/usr/bin/env python3\n# coding: utf-8\n# @claim A-1\n'],
    ['src/a.py', '# header\n# coding=utf-8\ndef allowed(): return true;\n', '# header\n# coding=utf-8\n# @claim A-1\n'],
    ['src/a.tsx', 'const el = <div/>;\nfunction allowed() { return true; }', '// @claim A-1\n'],
  ])('preserves protected headers and original bytes for %s', (file, text, prefix) => {
    const root = project(); writeFileSync(join(root, file), text);
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault(file)])) });
    expect(plan.refused).toEqual([]);
    expect(plan.files[0].proposed.startsWith(prefix)).toBe(true);
    expect(readFileSync(join(root, file), 'utf8')).toBe(text);
  });

  it('is idempotent per target, not fooled by an annotation in a different file or by code strings', () => {
    const root = project();
    writeFileSync(join(root, 'src/a.mjs'), '// @claim A-1\n' + source);
    writeFileSync(join(root, 'src/b.mjs'), 'const label = "@claim A-1";\n' + source);
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/a.mjs'), fault('src/b.mjs', 'return true;', { id: 'F2' })])) });
    expect(plan.files.map((f) => f.changed)).toEqual([false, true]);
  });

  it.each([
    ['missing.mjs', source, 'target-missing'],
    ['src/a.go', source, 'unsupported-source'],
    ['src/a.test.mjs', source, 'excluded-target'],
    ['src/a.mjs', source + source, 'anchor-ambiguous'],
    ['src/a.mjs', 'export const x = 1;\n', 'anchor-missing'],
    ['src/a.mjs', source + '\r\n', 'mixed-newlines'],
    ['src/a.mjs', source + '\0', 'invalid-encoding'],
  ])('refuses %s (%s) without admitting a partial apply', (file, text, reason) => {
    const root = project(); writeFileSync(join(root, 'src/good.mjs'), source);
    if (file.startsWith('src/')) writeFileSync(join(root, file), text);
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/good.mjs'), fault(file, 'return true;', { id: 'F2' })])) });
    expect(plan.refused).toContainEqual(expect.objectContaining({ file, reason }));
    expect(plan.applicable).toBe(false);
    expect(readFileSync(join(root, 'src/good.mjs'), 'utf8')).toBe(source);
  });

  it('refuses file and ancestor symlinks plus nested project ownership', () => {
    const root = project(); const outside = project(); writeFileSync(join(outside, 'src/a.mjs'), source);
    symlinkSync(join(outside, 'src/a.mjs'), join(root, 'src/link.mjs'));
    symlinkSync(join(outside, 'src'), join(root, 'linked'), 'dir');
    mkdirSync(join(root, 'child')); writeFileSync(join(root, 'child/testguard.claims.json'), '{}'); writeFileSync(join(root, 'child/a.mjs'), source);
    const claims = doc(claim('A-1', [fault('src/link.mjs'), fault('linked/a.mjs', 'return true;', { id: 'F2' }), fault('child/a.mjs', 'return true;', { id: 'F3' })]));
    expect(planAnnotationPlacement({ projectDir: root, claims }).refused.map((r) => r.reason)).toEqual(['nested-project', 'symlink-target', 'symlink-target']);
  });

  it('rejects unknown selections and invalid claim documents before reading targets', () => {
    const root = project();
    expect(() => planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/a.mjs')])), claimIds: ['UNKNOWN-1'] })).toThrow(/unknown claim/i);
    expect(() => planAnnotationPlacement({ projectDir: root, claims: { claims: [] } })).toThrow(/conform/i);
    expect(() => planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('../outside.mjs')])) })).toThrow(/conform/i);
  });

  it('does not treat annotation-looking lines in a multiline string as header annotations', () => {
    const root = project();
    const text = 'const example = `\n// @claim A-1\n`;\n' + source;
    writeFileSync(join(root, 'src/a.mjs'), text);
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/a.mjs')])) });
    expect(plan.files[0].proposed).toBe('// @claim A-1\n' + text);
  });

  it('refuses malformed UTF-8 and oversized source without reading them as valid text', () => {
    const root = project();
    writeFileSync(join(root, 'src/invalid.mjs'), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(root, 'src/large.mjs'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/invalid.mjs'), fault('src/large.mjs', 'return true;', { id: 'F2' })])) });
    expect(plan.refused.map((r) => r.reason)).toEqual(['invalid-encoding', 'source-too-large']);
    expect(plan.applicable).toBe(false);
  });

  it('admits exactly 16 MiB of source, then reports the remainder instead of a partial applicable plan', () => {
    const root = project();
    const annotated = '// @claim A-1\n' + source;
    const text = annotated + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(annotated));
    const faults = [];
    for (let i = 0; i < 9; i++) {
      const file = `src/a${i}.mjs`; writeFileSync(join(root, file), text);
      faults.push(fault(file, 'return true;', { id: `F${i + 1}` }));
    }
    reads.bytes = 0;
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', faults)) });
    expect(reads.bytes).toBe(16 * 1024 * 1024);
    expect(plan.files).toHaveLength(8);
    expect(plan.refused).toEqual([{ file: 'src/a8.mjs', claimIds: ['A-1'], reason: 'plan-source-budget' }]);
    expect(plan.applicable).toBe(false);
  });

  it('refuses header growth beyond the file ceiling without changing source', () => {
    const root = project(); const text = source + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(source));
    writeFileSync(join(root, 'src/a.mjs'), text);
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', [fault('src/a.mjs')])) });
    expect(plan.files).toHaveLength(0);
    expect(plan.refused).toEqual([{ file: 'src/a.mjs', claimIds: ['A-1'], reason: 'proposed-source-too-large' }]);
    expect(plan.applicable).toBe(false);
    expect(readFileSync(join(root, 'src/a.mjs'), 'utf8')).toBe(text);
  });

  it('charges proposed header growth against the aggregate ceiling', () => {
    const root = project(); const cap = 2 * 1024 * 1024;
    const text = source + ' '.repeat(cap - Buffer.byteLength('// @claim A-1\n') - Buffer.byteLength(source));
    const faults = [];
    for (let i = 0; i < 9; i++) {
      const file = `src/a${i}.mjs`; writeFileSync(join(root, file), i === 8 ? source : text);
      faults.push(fault(file, 'return true;', { id: `F${i + 1}` }));
    }
    const plan = planAnnotationPlacement({ projectDir: root, claims: doc(claim('A-1', faults)) });
    expect(plan.files).toHaveLength(8);
    expect(plan.files.every((file) => Buffer.byteLength(file.proposed) === cap)).toBe(true);
    expect(plan.refused).toEqual([{ file: 'src/a8.mjs', claimIds: ['A-1'], reason: 'plan-source-budget' }]);
    expect(plan.applicable).toBe(false);
  });

  it('revalidates an unchanged selected plan without modifying source', () => {
    const root = project(); writeFileSync(join(root, 'src/a.mjs'), source);
    const claims = doc(claim('A-1', [fault('src/a.mjs')]), claim('B-1', [fault('src/a.mjs')]));
    const plan = planAnnotationPlacement({ projectDir: root, claims, claimIds: ['A-1'] });
    const result = revalidateAnnotationPlan({ projectDir: root, claims, plan });
    expect(result.current).toBe(true);
    expect(result.plan).toEqual(plan);
    expect(result.plan).not.toBe(plan);
    expect(result.plan.files[0].claimIds).toEqual(['A-1']);
    expect(readFileSync(join(root, 'src/a.mjs'), 'utf8')).toBe(source);
  });

  it.each(['claims', 'source', 'identity', 'permissions', 'proposal', 'selection', 'root'])('refuses a preview after %s changes', (change) => {
    const root = project(); const path = join(root, 'src/a.mjs'); writeFileSync(path, source);
    const claims = doc(claim('A-1', [fault('src/a.mjs')]), claim('B-1', [fault('src/a.mjs')]));
    const plan = planAnnotationPlacement({ projectDir: root, claims, claimIds: ['A-1'] });
    if (change === 'claims') claims.claims[0].statement += ' An edited requirement.';
    if (change === 'source') writeFileSync(path, source + '// user edit\n');
    if (change === 'identity') { renameSync(path, join(root, 'src/original.mjs')); writeFileSync(path, source); }
    if (change === 'permissions') chmodSync(path, 0o600);
    if (change === 'proposal') plan.files[0].proposed = 'export const injected = true;\n';
    if (change === 'selection') plan.selectedClaimIds = ['B-1'];
    const result = revalidateAnnotationPlan({ projectDir: change === 'root' ? project() : root, claims, plan });
    expect(result.current).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.reason).toMatch(/changed|invalid|refused/);
    expect(readFileSync(path, 'utf8')).toBe(change === 'source' ? source + '// user edit\n' : source);
  });

  it('does not authorize an unchanged but refused plan', () => {
    const root = project(); const claims = doc(claim('A-1', [fault('src/missing.mjs')]));
    const plan = planAnnotationPlacement({ projectDir: root, claims });
    expect(revalidateAnnotationPlan({ projectDir: root, claims, plan })).toMatchObject({ current: false, reason: 'plan-refused' });
  });
});
