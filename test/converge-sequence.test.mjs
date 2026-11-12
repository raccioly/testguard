// #293, the reproduced defect and its edges, through the CLI: full probe, a
// committed change that touches no fault anchor, `probe --changed HEAD~1`,
// then `status`. Before convergence the project stayed `evidence-stale` and
// `next` asked for the full probe again.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// One full probe for the whole file: every case starts from a copy of this
// probed repository, so the file pays for one full probe instead of nine.
let seed;
beforeAll(async () => {
  seed = project();
  expect((await run(['probe', seed.dir, ...node, '--quiet'])).code).toBe(0);
});
afterAll(() => rmSync(seed.root, { recursive: true, force: true }));

/** A copy of the probed seed. */
function probed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-converge-')));
  cpSync(seed.root, root, { recursive: true });
  roots.push(root);
  return { root, dir: root, base: seed.base };
}

/** A probed project with one committed edit to src/tax.mjs that moves no anchor. */
async function probedThenEdited() {
  const p = probed();
  touch(p.dir, 'src/tax.mjs');
  commit(p.root, 'edit tax');
  return p;
}

describe('a change-scoped probe converges the canonical evidence', () => {
  it('a later scoped run reuses a carried record under the full rule, and it is no longer marked carried', async () => {
    const p = await probedThenEdited();
    expect((await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--quiet'])).code).toBe(0);
    expect(read(canonical(p.dir)).records.filter((x) => x.claim.id === 'PRICE-TOTAL').map((x) => x.carried)).toEqual(['inputs-match', 'inputs-match']);
    const r = await run(['probe', p.dir, ...node, '--claim', 'PRICE-TOTAL', '--json']);
    expect(r.code).toBe(0);
    const price = read(canonical(p.dir)).records.filter((x) => x.claim.id === 'PRICE-TOTAL');
    expect(price.map((x) => [Boolean(x.reusedFrom), x.carried])).toEqual([[true, undefined], [true, undefined]]);
  });

  it('status and baseline agree when a record is kept for an input status does not hash (a new test file)', async () => {
    const p = probed();
    // One commit: the change TAX-DOUBLES is selected for, and a new test file
    // that touches no claim but changes the runner's test universe.
    touch(p.dir, 'src/tax.mjs');
    writeFileSync(join(p.dir, 'test/unrelated.test.mjs'), "import { test } from 'node:test';\ntest('unrelated', () => {});\n");
    commit(p.root, 'tax and an unrelated test');
    const r = JSON.parse((await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--json'])).out);
    expect(r.run.converged.stale).toEqual(['PRICE-TOTAL/F1', 'PRICE-TOTAL/F2']);
    const status = await statusOf(p.dir);
    expect(status.state).toBe('evidence-stale');
    expect(status.stale.join('\n')).toMatch(/PRICE-TOTAL\/F1 was kept stale by a scoped probe/);
    expect((await run(['baseline', p.dir])).code).toBe(2);
  });

  it('judges the assertion policy over its selection: a stale record outside it does not fail the run (review A)', async () => {
    const p = await probedThenEdited();
    touch(p.dir, 'src/price.mjs');
    commit(p.root, 'edit price');
    // TAX-DOUBLES changed before HEAD~1: kept stale, outside the selection.
    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--require-assertion-kill']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/assertion policy: passed/);
    expect(r.out).toMatch(/assertion policy: 2 records kept stale outside the selection were not judged; the evidence file's policy is unavailable until they are probed/);
    expect(read(canonical(p.dir)).assertionPolicy.state).toBe('unavailable');
  });

  it('names the records it kept stale, and baseline refuses the document', async () => {
    const p = await probedThenEdited();
    touch(p.dir, 'src/price.mjs');
    commit(p.root, 'edit price');
    expect((await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--quiet'])).out).toMatch(/2 kept unchanged and still stale, because .*: TAX-DOUBLES\/F1, TAX-DOUBLES\/F2/);
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

  it('records a carried kill with no recorded kill kind as a failure of the evidence file\'s policy, outside the run\'s own judgment', async () => {
    const p = await probedThenEdited();
    const old = read(canonical(p.dir));
    for (const x of old.records) if (x.claim.id === 'PRICE-TOTAL') { delete x.detail.killKind; delete x.detail.killKindReason; }
    writeFileSync(canonical(p.dir), JSON.stringify(old, null, 2));
    const r = await run(['probe', p.dir, ...node, '--changed', 'HEAD~1', '--require-assertion-kill']);
    // The selection (TAX-DOUBLES) was killed by assertions: the run passes, as a scoped run always judged what it measured.
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/the evidence file's policy is failed, because of records outside this selection that this run did not judge: PRICE-TOTAL\/F1, PRICE-TOTAL\/F2/);
    const doc = read(canonical(p.dir));
    expect(doc.records.filter((x) => x.carried === 'inputs-match').length).toBe(2);
    expect(doc.assertionPolicy.exceptionOnlyKills.map((k) => `${k.claimId}/${k.faultId}`)).toEqual(['PRICE-TOTAL/F1', 'PRICE-TOTAL/F2']);
  });
});
