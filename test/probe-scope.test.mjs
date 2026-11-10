// Issue #234: `probe --changed <ref>` selects the claims a change can have
// affected, and says plainly when it selected none or could not tell.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { parseNameStatus, resolveProbeScope, SCOPE_NOTE } from '../src/probe/scope.mjs';
import { validate } from '../spec/lib/validate.mjs';
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

describe('probe --changed through the CLI', () => {
  const capture = () => {
    const lines = { out: [], err: [] };
    return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
  };
  const run = async (args) => {
    const c = capture();
    const code = await main(args, c.io);
    return { code, out: c.lines.out.join('\n'), err: c.lines.err.join('\n') };
  };
  const common = ['--runner', 'node-test', '--confirm', '3'];

  it('selects zero claims when the ref is HEAD: says so, exits 0, probes and writes nothing', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--changed', 'HEAD', '--json', ...common]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run).toEqual({ exitCode: 0, scope: { probedClaims: [], probedCount: 0, selectedCount: 0, changed: expect.objectContaining({ ref: 'HEAD', outcome: 'determined', files: [], matchedClaims: [], unmatchedFiles: [], note: SCOPE_NOTE }) } });
    expect(r.out).not.toContain('"records"');
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });
  it('prints the explicit empty-selection line in text mode', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--changed', 'HEAD', ...common]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 claims selected, nothing probed\. This is not a pass for the change/);
  });
  it('exits 2 on an empty selection under --fail-on-empty-selection, in the JSON too', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--changed', 'HEAD', '--fail-on-empty-selection', '--json', ...common]);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.exitCode).toBe(2);
    expect(doc.run.scope.selectedCount).toBe(0);
    const text = await run(['probe', p.dir, '--changed', 'HEAD', '--fail-on-empty-selection', ...common]);
    expect(text.code).toBe(2);
    expect(text.out).toMatch(/--fail-on-empty-selection treats an empty selection as a failure/);
  });
  it('lists the changed source files no claim covers, with the line that says absence is not a pass', async () => {
    const p = repo();
    edit(p.dir, 'src/orphan.mjs', 'export const orphan = () => 2;\n');
    commit(p.dir);
    const r = await run(['probe', p.dir, '--changed', p.base, ...common]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 changed source file is not covered by any claim; absence from the results is not a pass: src/orphan.mjs');
  });
  it('refuses --fail-on-empty-selection without --changed, and --require-origin with it', async () => {
    const p = repo();
    expect((await run(['probe', p.dir, '--fail-on-empty-selection', ...common])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'HEAD', '--require-origin', 'spec', ...common])).code).toBe(3);
  });
  it('refuses --changed with --ref or --in-place: the selection would describe another tree than the one probed', async () => {
    const p = repo();
    expect((await run(['probe', p.dir, '--changed', 'HEAD', '--ref', 'HEAD', ...common])).code).toBe(3);
    expect((await run(['probe', p.dir, '--changed', 'HEAD', '--in-place', ...common])).code).toBe(3);
  });
  it('also lists the uncovered changed files after a measured run', async () => {
    const p = repo();
    edit(p.dir, 'src/tax.mjs', 'export const tax = (n) => n * 2 + 0;\n');
    edit(p.dir, 'src/orphan.mjs', 'export const orphan = () => 2;\n');
    commit(p.dir);
    const r = await run(['probe', p.dir, '--changed', p.base, ...common]);
    expect(r.out).toContain('not covered by any claim; absence from the results is not a pass: src/orphan.mjs');
  });
  it('an unknown --claim is an error whatever the change is', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--changed', 'HEAD', '--claim', 'NOPE', ...common]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown claim id/);
  });
  it('exits 2 for a ref that does not resolve, names why, and probes nothing', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--changed', 'no-such-ref', '--json', ...common]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot tell what changed since no-such-ref \(ref-unresolved\).*Nothing was probed/);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run).toEqual({ exitCode: 2, scope: { probedClaims: [], probedCount: 0, changed: { ref: 'no-such-ref', outcome: 'undetermined', reason: { kind: 'ref-unresolved', message: expect.stringContaining('no-such-ref') } } } });
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });
  it('probes only the selected claims into the partial evidence file and reports every claim by id', async () => {
    const p = repo();
    edit(p.dir, 'src/helper.mjs', 'export const round = (n) => Math.round(n * 1);\n');
    commit(p.dir);
    const r = await run(['probe', p.dir, '--changed', p.base, '--json', ...common]);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.evidence).toBe(join(p.dir, '.testguard', 'evidence-partial.json'));
    expect(existsSync(join(p.dir, '.testguard', 'evidence.json'))).toBe(false);
    expect(doc.run.scope).toMatchObject({ probedClaims: ['PRICE-TOTAL'], probedCount: 1, selectedCount: 1, changed: { outcome: 'determined', ref: p.base, files: ['src/helper.mjs'], matchedClaims: ['PRICE-TOTAL'], unmatchedFiles: [] } });
    expect(doc.run.scope.requestedClaims).toBeUndefined();
    expect(doc.run.claims).toEqual([{ id: 'PRICE-TOTAL', result: 'proven', faults: expect.objectContaining({ total: 2, killed: 2 }), reasons: [] }]);
    const evidence = JSON.parse(readFileSync(doc.run.evidence, 'utf8'));
    expect([...new Set(evidence.records.map((x) => x.claim.id))]).toEqual(['PRICE-TOTAL']);
  });
  it('writes the survivor into run.claims as unproven, with the fault id as the reason key', async () => {
    const p = repo();
    // A defender that asserts nothing the fault changes.
    const weak = "import { test } from 'node:test';\nimport { tax } from '../src/tax.mjs';\n\ntest('tax runs', () => { tax(2); });\n";
    edit(p.dir, 'test/tax.test.mjs', weak);
    commit(p.dir);
    const r = await run(['probe', p.dir, '--changed', p.base, '--json', ...common]);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(r.code).toBe(1);
    expect(doc.run.claims).toHaveLength(1);
    expect(doc.run.claims[0]).toMatchObject({ id: 'TAX-DOUBLES', result: 'unproven' });
    expect(doc.run.claims[0].reasons.map((x) => x.faultId).sort()).toEqual(['F1', 'F2']);
  });
});
