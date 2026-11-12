// #297: `--changed` selects a claim whose defenders are DISCOVERED when any of
// its discovery inputs changed (a candidate test file, or a file a candidate
// imports, at HEAD or as recorded in the evidence), and when discovery itself
// is indeterminate. Under-selection would leave a verdict standing that a new
// defender could change.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { commit, project, claimsDoc } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

/** TAX-DOUBLES with discovered defenders; PRICE-TOTAL as declared. src/price.mjs is imported by test/price.test.mjs, a candidate, so it is one of TAX-DOUBLES' discovery inputs. */
const discovered = () => {
  const claims = claimsDoc();
  delete claims.claims[1].defendedBy;
  const p = project({ claims });
  roots.push(p.root);
  return p;
};
const scope = (p, extra = {}) => resolveProbeScope({ projectDir: p.dir, claims: JSON.parse(readFileSync(join(p.dir, 'testguard.claims.json'), 'utf8')), ref: p.base, ...extra });

describe('a claim with discovered defenders', () => {
  it('is selected when a file a candidate test imports changes (its discovery input)', () => {
    const p = discovered();
    writeFileSync(join(p.dir, 'src/price.mjs'), "import { round } from './helper.mjs';\nexport const total = (a, b) => round(a + b) + 0;\n");
    commit(p.root, 'price');
    expect(scope(p).selected).toEqual(['PRICE-TOTAL', 'TAX-DOUBLES']);
    expect(scope(p).matchReasons.find((r) => r.claimId === 'TAX-DOUBLES')).toMatchObject({ kind: 'discovery', file: 'src/price.mjs' });
  });

  it('is selected when a candidate test file is added or deleted', () => {
    const p = discovered();
    writeFileSync(join(p.dir, 'test/extra.test.mjs'), "import { test } from 'node:test';\ntest('extra', () => {});\n");
    commit(p.root, 'add a test');
    expect(scope(p).selected).toContain('TAX-DOUBLES');
    const q = discovered();
    rmSync(join(q.dir, 'test/price.test.mjs'));
    commit(q.root, 'delete a candidate');
    // The deleted file is no candidate at HEAD: only the evidence remembers it.
    mkdirSync(join(q.dir, '.testguard'), { recursive: true });
    writeFileSync(join(q.dir, '.testguard', 'evidence.json'), JSON.stringify({ records: [{ claim: { id: 'TAX-DOUBLES' }, subject: { id: 'F1' }, inputs: { discoveryHashes: { 'test/price.test.mjs': 'x', 'test/tax.test.mjs': 'y' } } }] }));
    expect(scope(q).selected).toContain('TAX-DOUBLES');
  });

  it('is not selected by a change to a file outside its discovery inputs; a declared claim is unchanged', () => {
    const p = discovered();
    writeFileSync(join(p.dir, 'src/orphan.mjs'), 'export const orphan = () => 2;\n');
    commit(p.root, 'orphan');
    expect(scope(p).selected).toEqual([]);
  });
});
