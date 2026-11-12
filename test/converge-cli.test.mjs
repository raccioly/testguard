// #293, the reproduced defect, through the CLI (its edges are in
// converge-sequence.test.mjs): full probe, a
// committed change that touches no fault anchor, `probe --changed HEAD~1`,
// then `status`. Before convergence the project stayed `evidence-stale` and
// `next` asked for the full probe again.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const run = async (args, deps) => {
  const out = [];
  const err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const node = ['--runner', 'node-test'];
const statusOf = async (dir) => JSON.parse((await run(['status', dir, '--json'])).out);
const canonical = (dir) => join(dir, '.testguard', 'evidence.json');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const touch = (dir, file) => writeFileSync(join(dir, file), `// edited\n${readFileSync(join(dir, file), 'utf8')}`);

/** A probed project with one committed edit to src/tax.mjs that moves no anchor. */
async function probedThenEdited() {
  const p = project();
  roots.push(p.root);
  expect((await run(['probe', p.dir, ...node, '--quiet'])).code).toBe(0);
  touch(p.dir, 'src/tax.mjs');
  commit(p.root, 'edit tax');
  return p;
}

describe('a change-scoped probe converges the canonical evidence', () => {
  it('ends the reproduced sequence fresh, with next no longer the full probe', async () => {
    const p = await probedThenEdited();
    const before = await statusOf(p.dir);
    expect(before.state).toBe('evidence-stale');
    expect(before.next.command).toBe('testguard probe --include-dirty');

    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.evidence).toBe(canonical(p.dir));
    expect(doc.run.converged).toMatchObject({ into: canonical(p.dir), carried: 2, stale: [] });
    expect(existsSync(join(p.dir, '.testguard', 'evidence-partial.json'))).toBe(false);

    const evidence = read(canonical(p.dir));
    expect(evidence.run.scope.selectedClaims).toEqual(['TAX-DOUBLES']);
    expect(evidence.records.map((x) => [x.claim.id, x.carried ?? 'measured'])).toEqual([
      ['PRICE-TOTAL', 'inputs-match'], ['PRICE-TOTAL', 'inputs-match'], ['TAX-DOUBLES', 'measured'], ['TAX-DOUBLES', 'measured'],
    ]);

    const after = await statusOf(p.dir);
    expect(after.stale).toEqual([]);
    expect(after.state).toBe('clean');
    expect(after.next.action).not.toBe('probe');
    expect(after.notes.join('\n')).toMatch(/2 records were carried .* environment not re-checked/);

    // Then a record whose inputs changed is never carried as fresh: TAX-DOUBLES
    // changes in one commit, and the next --changed HEAD~1 covers only the
    // commit after it, which touches PRICE-TOTAL alone.
    touch(p.dir, 'src/tax.mjs');
    commit(p.root, 'edit tax again');
    touch(p.dir, 'src/price.mjs');
    commit(p.root, 'edit price');
    const again = JSON.parse((await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--json'])).out);
    expect(again.run.converged).toMatchObject({ carried: 0, stale: ['TAX-DOUBLES/F1', 'TAX-DOUBLES/F2'] });
    expect(read(canonical(p.dir)).records.map((x) => x.carried ?? 'measured')).toEqual(['measured', 'measured', 'inputs-changed', 'inputs-changed']);
    const stale = await statusOf(p.dir);
    expect(stale.state).toBe('evidence-stale');
    expect(stale.stale.join('\n')).toMatch(/src\/tax\.mjs changed since TAX-DOUBLES\/F1/);
  });

});
