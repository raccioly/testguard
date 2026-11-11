// Issue #234: `probe --changed` through the CLI: the three outcomes, the exit
// codes, and the JSON a caller reads. Split from probe-scope.test.mjs so the
// claims over the selection logic do not pay for these nested probes.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { SCOPE_NOTE } from '../src/probe/scope.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const repo = (options) => { const p = project(options); roots.push(p.root); return p; };
const edit = (dir, file, text) => writeFileSync(join(dir, file), text);

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
  // The measured runs below prove what the caller reads, not the verdict's stability: one run each keeps them cheap.
  const quick = ['--runner', 'node-test', '--confirm', '1'];

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
    const r = await run(['probe', p.dir, '--changed', p.base, ...quick]);
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
    const r = await run(['probe', p.dir, '--changed', p.base, '--json', ...quick]);
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
    const r = await run(['probe', p.dir, '--changed', p.base, '--json', ...quick]);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(r.code).toBe(1);
    expect(doc.run.claims).toHaveLength(1);
    expect(doc.run.claims[0]).toMatchObject({ id: 'TAX-DOUBLES', result: 'unproven' });
    expect(doc.run.claims[0].reasons.map((x) => x.faultId).sort()).toEqual(['F1', 'F2']);
  });
});
