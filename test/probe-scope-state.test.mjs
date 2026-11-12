// Defect A of the 0.22.1 verification: a --claim run reported the whole file's
// state, so a broken anchor on a claim the caller never selected told them to
// repair something their run had nothing to do with. The whole-file state is
// still true and stays; the selection gets a view of its own.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { claimsDoc, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};
const run = async (args) => {
  const c = capture();
  const code = await main(args, c.io);
  return { code, out: c.lines.out.join('\n'), err: c.lines.err.join('\n') };
};
const quick = ['--runner', 'node-test', '--confirm', '1'];

/** A repository whose TAX-DOUBLES claim has an anchor that no longer locates; PRICE-TOTAL is sound. */
const withBrokenOtherClaim = () => {
  const claims = claimsDoc();
  claims.claims[1].faults[1].find = 'text that is nowhere in src/tax.mjs';
  const p = project({ claims });
  roots.push(p.root);
  return p;
};

describe('a scoped run separates the selection from the rest of the file', () => {
  it('keeps the whole-file state, and gives the selected claims a state of their own', async () => {
    const p = withBrokenOtherClaim();
    const r = await run(['probe', p.dir, '--claim', 'PRICE-TOTAL', '--json', ...quick]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    // True of the file, and unchanged: another claim's anchor is broken.
    expect(doc.state).toBe('invalid-anchors');
    expect(doc.next.target.claimId).toBe('TAX-DOUBLES');
    // True of the selection: nothing in PRICE-TOTAL needs repair.
    expect(doc.run.scope.state).not.toBe('invalid-anchors');
    expect(doc.run.scope.next).toBeDefined();
    expect(JSON.stringify(doc.run.scope)).not.toContain('TAX-DOUBLES');
    expect(doc.run.scope.next.target?.claimId ?? 'PRICE-TOTAL').toBe('PRICE-TOTAL');
  });

  it('leads the human output with the selection, then names what is outside it', async () => {
    const p = withBrokenOtherClaim();
    const r = await run(['probe', p.dir, '--claim', 'PRICE-TOTAL', ...quick]);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    const scoped = lines.findIndex((line) => /^scope:\s+\S+ over 1 selected claim/.test(line));
    const rest = lines.findIndex((line) => /^rest of the file:\s+invalid-anchors/.test(line));
    expect(scoped).toBeGreaterThanOrEqual(0);
    expect(rest).toBeGreaterThan(scoped);
    expect(lines[scoped]).not.toContain('TAX-DOUBLES');
  });

  it('an unscoped run carries no scoped view', async () => {
    const p = project();
    roots.push(p.root);
    const r = await run(['probe', p.dir, '--json', ...quick]);
    const doc = JSON.parse(r.out);
    expect(doc.run.scope).toBeUndefined();
  });

  it('is computed for --changed too, over only the claims the change selected', async () => {
    const claims = claimsDoc();
    claims.claims[1].faults[1].find = 'text that is nowhere in src/tax.mjs';
    const p = project({ claims });
    roots.push(p.root);
    writeFileSync(join(p.dir, 'src/price.mjs'), "import { round } from './helper.mjs';\nexport const total = (a, b) => round(a + b); // touched\n");
    const { commit } = await import('./helpers/scope-project.mjs');
    commit(p.dir);
    const r = await run(['probe', p.dir, '--changed', p.base, '--json', ...quick]);
    const doc = JSON.parse(r.out);
    expect(doc.run.scope.changed.matchedClaims).toEqual(['PRICE-TOTAL']);
    expect(doc.state).toBe('invalid-anchors');
    expect(doc.run.scope.state).toBeDefined();
    expect(doc.run.scope.state).not.toBe('invalid-anchors');
  });
});
