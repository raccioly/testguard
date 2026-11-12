// #293, the reproduced defect and its edges, through the CLI: full probe, a
// committed change that touches no fault anchor, `probe --changed HEAD~1`,
// then `status`. Before convergence the project stayed `evidence-stale` and
// `next` asked for the full probe again.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { probeCommand } from '../src/commands/probe.mjs';
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
  });

  it('never carries a record whose inputs changed: it is kept stale, named, and baseline refuses the document', async () => {
    const p = await probedThenEdited();
    touch(p.dir, 'src/price.mjs');
    commit(p.root, 'edit price');
    // HEAD~1..HEAD touches only price.mjs, so TAX-DOUBLES is not selected; its inputs changed in the commit before.
    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).run.converged).toMatchObject({ carried: 0, stale: ['TAX-DOUBLES/F1', 'TAX-DOUBLES/F2'] });
    const tax = read(canonical(p.dir)).records.filter((x) => x.claim.id === 'TAX-DOUBLES');
    expect(tax.map((x) => x.carried)).toEqual(['inputs-changed', 'inputs-changed']);
    const status = await statusOf(p.dir);
    expect(status.state).toBe('evidence-stale');
    expect(status.stale.join('\n')).toMatch(/src\/tax\.mjs changed since TAX-DOUBLES\/F1/);
    const b = await run(['baseline', p.dir]);
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/inputs changed.*TAX-DOUBLES\/F1, TAX-DOUBLES\/F2/);
  });

  it('carries nothing from evidence another TestGuard version measured, and leaves it untouched', async () => {
    const p = await probedThenEdited();
    const old = read(canonical(p.dir));
    old.tool.version = '0.0.1';
    old.run.instrument.toolVersion = '0.0.1';
    writeFileSync(canonical(p.dir), JSON.stringify(old, null, 2));
    const bytes = readFileSync(canonical(p.dir), 'utf8');
    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).run.converged).toEqual({ into: null, reason: expect.stringMatching(/measured by TestGuard 0\.0\.1/) });
    expect(readFileSync(canonical(p.dir), 'utf8')).toBe(bytes);
    expect(existsSync(join(p.dir, '.testguard', 'evidence-partial.json'))).toBe(true);
  });

  it.each([
    ['an undetermined scope', ['--changed', 'no-such-ref'], 2, false],
    ['a provisional run', ['--changed', 'HEAD~1', '--confirm', '1'], 0, true],
    ['--no-reuse', ['--changed', 'HEAD~1', '--no-reuse'], 0, true],
  ])('%s never touches the canonical file', async (_, args, exit, partial) => {
    const p = await probedThenEdited();
    const bytes = readFileSync(canonical(p.dir), 'utf8');
    const r = await run(['probe', p.dir, ...node, ...args, '--quiet']);
    expect(r.code).toBe(exit);
    expect(readFileSync(canonical(p.dir), 'utf8')).toBe(bytes);
    expect(existsSync(join(p.dir, '.testguard', 'evidence-partial.json'))).toBe(partial);
    expect((await statusOf(p.dir)).state).toBe('evidence-stale');
  });

  it('does not overwrite a canonical file another command wrote while it ran', async () => {
    const p = await probedThenEdited();
    let wrote = false;
    const out = [];
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const values = { confirm: '3', budget: '60000', runner: 'node-test', severity: 'low', progress: 'none', changed: 'HEAD~1', 'include-dirty': false, json: true };
    await probeCommand({ projectDir: p.dir, values, version }, { out: (s) => out.push(s), err: () => {} }, {
      onStage: () => {
        if (wrote) return;
        wrote = true;
        const other = read(canonical(p.dir));
        other.run.id = 'run-20991231T000000';
        writeFileSync(canonical(p.dir), JSON.stringify(other, null, 2));
      },
    });
    expect(wrote).toBe(true);
    expect(JSON.parse(out.join('\n')).run.converged).toEqual({ into: null, reason: 'another command wrote the canonical evidence while this one ran' });
    expect(read(canonical(p.dir)).run.id).toBe('run-20991231T000000');
  });

  it('judges a carried kill with no recorded kill kind under --require-assertion-kill', async () => {
    const p = await probedThenEdited();
    const old = read(canonical(p.dir));
    for (const x of old.records) if (x.claim.id === 'PRICE-TOTAL') { delete x.detail.killKind; delete x.detail.killKindReason; }
    writeFileSync(canonical(p.dir), JSON.stringify(old, null, 2));
    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--require-assertion-kill', '--json']);
    const doc = JSON.parse(r.out);
    expect(doc.run.converged.carried).toBe(2);
    expect(r.code).toBe(1);
    expect(doc.run.assertionPolicy.exceptionOnlyKills.map((k) => `${k.claimId}/${k.faultId}`)).toEqual(['PRICE-TOTAL/F1', 'PRICE-TOTAL/F2']);
  });
});
