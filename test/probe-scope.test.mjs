// Issue #234: `probe --changed <ref>` selects the claims a change can have
// affected, and says plainly when it selected none or could not tell.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNameStatus, resolveProbeScope, SCOPE_NOTE } from '../src/probe/scope.mjs';
import { commit, git, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const repo = (options) => { const p = project(options); roots.push(p.root); return p; };
const claimsOf = (dir) => JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
const scope = (p, extra = {}) => resolveProbeScope({ projectDir: p.dir, claims: claimsOf(p.dir), ref: p.base, ...extra });
const edit = (dir, file, text) => writeFileSync(join(dir, file), text);

describe('parseNameStatus', () => {
  it('reads one path for a change and both for a rename or copy', () => {
    expect(parseNameStatus('M\0a.mjs\0D\0b.mjs\0A\0c.mjs\0R100\0old.mjs\0new.mjs\0C75\0src.mjs\0copy.mjs\0')).toEqual([
      { status: 'M', paths: ['a.mjs'] }, { status: 'D', paths: ['b.mjs'] }, { status: 'A', paths: ['c.mjs'] },
      { status: 'R', paths: ['old.mjs', 'new.mjs'] }, { status: 'C', paths: ['src.mjs', 'copy.mjs'] },
    ]);
  });
  it('reads nothing from empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('which claims a change selects', () => {
  it('selects nothing when the ref is HEAD, and says it was determined', () => {
    const r = scope(repo());
    expect(r).toMatchObject({ outcome: 'determined', files: [], matchedClaims: [], unmatchedFiles: [], selected: [], note: SCOPE_NOTE });
  });
  it('selects the claim whose target changed and no other', () => {
    const p = repo();
    edit(p.dir, 'src/tax.mjs', 'export const tax = (n) => n * 2 + 0;\n');
    commit(p.dir);
    expect(scope(p)).toMatchObject({ files: ['src/tax.mjs'], matchedClaims: ['TAX-DOUBLES'], selected: ['TAX-DOUBLES'], unmatchedFiles: [] });
  });
  it('selects the claim whose defender changed', () => {
    const p = repo();
    edit(p.dir, 'test/price.test.mjs', `${readFileSync(join(p.dir, 'test/price.test.mjs'), 'utf8')}\n// edited\n`);
    commit(p.dir);
    expect(scope(p).selected).toEqual(['PRICE-TOTAL']);
  });
  it('selects through the import closure: a helper the target imports changed', () => {
    const p = repo();
    edit(p.dir, 'src/helper.mjs', 'export const round = (n) => Math.floor(n);\n');
    commit(p.dir);
    expect(scope(p)).toMatchObject({ matchedClaims: ['PRICE-TOTAL'], selected: ['PRICE-TOTAL'], unmatchedFiles: [] });
  });
  it('selects every claim when a manifest that decides what is installed changed', () => {
    const p = repo();
    edit(p.dir, 'package.json', JSON.stringify({ name: 'scope-fixture', private: true, type: 'module', version: '2.0.0' }));
    commit(p.dir);
    expect(scope(p).selected).toEqual(['PRICE-TOTAL', 'TAX-DOUBLES']);
  });
  it('reports a changed source file no claim touches, and does not select for it', () => {
    const p = repo();
    edit(p.dir, 'src/orphan.mjs', 'export const orphan = () => 2;\n');
    commit(p.dir);
    expect(scope(p)).toMatchObject({ files: ['src/orphan.mjs'], matchedClaims: [], selected: [], unmatchedFiles: ['src/orphan.mjs'] });
  });
  it('does not list a changed file that is not source as unmatched', () => {
    const p = repo();
    edit(p.dir, 'README.md', '# changed\n');
    commit(p.dir);
    expect(scope(p)).toMatchObject({ files: ['README.md'], unmatchedFiles: [], selected: [] });
  });
  it('intersects with --claim in the caller\'s order, and drops a requested claim the change did not reach', () => {
    const p = repo();
    edit(p.dir, 'package.json', JSON.stringify({ name: 'scope-fixture', private: true, type: 'module', version: '2.0.0' }));
    commit(p.dir);
    expect(scope(p, { only: ['TAX-DOUBLES', 'PRICE-TOTAL'] }).selected).toEqual(['TAX-DOUBLES', 'PRICE-TOTAL']);
    const q = repo();
    edit(q.dir, 'src/helper.mjs', 'export const round = (n) => Math.floor(n);\n');
    commit(q.dir);
    const r = scope(q, { only: ['TAX-DOUBLES'] });
    expect(r.selected).toEqual([]);
    expect(r.matchedClaims).toEqual(['PRICE-TOTAL']);
  });
  it('selects a claim through the OLD path of a renamed defender and the NEW one', () => {
    const p = repo();
    git(p.dir, 'mv', 'test/tax.test.mjs', 'test/tax-renamed.test.mjs');
    commit(p.dir);
    const r = scope(p);
    expect(r.files).toEqual(['test/tax-renamed.test.mjs', 'test/tax.test.mjs']);
    // The claim still names the old path (its defendedBy): the old side selects it.
    expect(r.selected).toEqual(['TAX-DOUBLES']);
    // And a claim that names the NEW path is selected through it.
    const claims = claimsOf(p.dir);
    claims.claims[1].defendedBy = ['test/tax-renamed.test.mjs'];
    expect(resolveProbeScope({ projectDir: p.dir, claims, ref: p.base }).selected).toEqual(['TAX-DOUBLES']);
  });
  it('selects a claim through the old path of a renamed fault target', () => {
    const p = repo();
    git(p.dir, 'mv', 'src/tax.mjs', 'src/tax-renamed.mjs');
    commit(p.dir);
    const r = scope(p);
    expect(r.files).toEqual(['src/tax-renamed.mjs', 'src/tax.mjs']);
    expect(r.selected).toEqual(['TAX-DOUBLES']);
  });
  it('counts a deleted defender as a change', () => {
    const p = repo();
    git(p.dir, 'rm', '-q', 'test/tax.test.mjs');
    commit(p.dir);
    expect(scope(p)).toMatchObject({ files: ['test/tax.test.mjs'], selected: ['TAX-DOUBLES'] });
  });
  it('reads the working tree only with includeDirty, untracked files included', () => {
    const p = repo();
    edit(p.dir, 'src/tax.mjs', 'export const tax = (n) => n * 2 + 0;\n');
    edit(p.dir, 'src/new.mjs', 'export const n = 1;\n');
    expect(scope(p).files).toEqual([]);
    const dirty = scope(p, { includeDirty: true });
    expect(dirty.files).toEqual(['src/new.mjs', 'src/tax.mjs']);
    expect(dirty).toMatchObject({ includeDirty: true, selected: ['TAX-DOUBLES'], unmatchedFiles: ['src/new.mjs'] });
  });
  it('maps repository paths to project paths and ignores a change outside the project', () => {
    const p = repo({ sub: 'pkg' });
    edit(p.dir, 'src/tax.mjs', 'export const tax = (n) => n * 2 + 0;\n');
    edit(p.root, 'elsewhere.mjs', 'export const e = 1;\n');
    commit(p.root);
    expect(scope(p)).toMatchObject({ files: ['src/tax.mjs'], selected: ['TAX-DOUBLES'] });
  });
  it('selects a claim whose closure cannot be followed when anything changed, and not when nothing did', () => {
    const p = repo({ files: { 'src/tax.mjs': "import { gone } from './missing.mjs';\nexport const tax = (n) => n * 2;\n" } });
    expect(scope(p).selected).toEqual([]);
    edit(p.dir, 'src/orphan.mjs', 'export const orphan = () => 2;\n');
    commit(p.dir);
    const r = scope(p);
    expect(r.selected).toEqual(['TAX-DOUBLES']);
    expect(r.matchedClaims).toEqual(['TAX-DOUBLES']);
  });
  it('selects every claim when an extended tsconfig that decides how imports resolve changed', () => {
    const p = repo({ files: { 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n', 'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n' } });
    edit(p.dir, 'tsconfig.base.json', '{ "compilerOptions": { "paths": { "@/*": ["./lib/*"] } } }\n');
    commit(p.dir);
    expect(scope(p).selected).toEqual(['PRICE-TOTAL', 'TAX-DOUBLES']);
  });
  it('rejects a ref git would read as an option, without running git on it', () => {
    expect(scope(repo(), { ref: '--output=x' })).toMatchObject({ outcome: 'undetermined', reason: { kind: 'ref-unresolved' } });
  });
});
