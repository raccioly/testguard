// #320: claims --check-anchors on a large claims file. One message holding every mutated source overran the
// string a parser process can be sent, and the throw left that process waiting for input: a crash, then a hang.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BATCH_CHARS, checkAnchors, cutBatches, runBatchCheck } from '../src/claims/anchors.mjs';
import { ClaimsError } from '../src/claims/load.mjs';
import { main } from '../src/cli.mjs';

const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tg-anchor-batches-')); made.push(d); return d; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const HANGS = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)']; // a parser that never answers

const LINES = 4000;
const NUM = (i) => String(i).padStart(5, '0');
/** ~200 KB of valid JavaScript with a unique anchor per line. */
const bigSource = () => Array.from({ length: LINES }, (_, i) => `const value_${NUM(i)} = ${i}; // padding padding padding padding padding`).join('\n') + '\n';
const fault = (i, replace) => ({ id: `F${NUM(i)}`, description: 'd', faultClass: 'other', file: 'big.mjs', find: `const value_${NUM(i)} = ${i};`, replace, producedBy: { producer: 'human' } });
const claimsDoc = (faults) => ({ schemaVersion: 1, claims: [{ id: 'C-1', statement: 'The example remains valid.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults }] });
const project = (faultCount, invalidAt) => {
  const dir = tmp();
  writeFileSync(join(dir, 'big.mjs'), bigSource());
  const faults = Array.from({ length: faultCount }, (_, i) => fault(i * 10, i === invalidAt ? 'const broken = (;' : `const value_${NUM(i * 10)} = -1;`));
  return { dir, faults, doc: claimsDoc(faults) };
};

describe('cutBatches', () => {
  it('closes a batch when its summed size would pass the cap, and an oversized item goes alone', () => {
    expect(cutBatches([], 10)).toEqual([]);
    expect(cutBatches([4, 4, 4], 10)).toEqual([[0, 2], [2, 3]]);
    expect(cutBatches([5, 5, 5, 5], 10)).toEqual([[0, 2], [2, 4]]); // exactly the cap still fits
    expect(cutBatches([3, 50, 3, 3], 10)).toEqual([[0, 1], [1, 2], [2, 4]]);
    expect(cutBatches([50, 50], 10)).toEqual([[0, 1], [1, 2]]);
    expect(cutBatches([1, 1, 1], 10)).toEqual([[0, 3]]);
  });
  it('cuts at 4,000,000 characters by default and covers every item once, in order', () => {
    expect(BATCH_CHARS).toBe(4_000_000);
    const sizes = Array.from({ length: 60 }, () => 200_000);
    const cuts = cutBatches(sizes);
    expect(cuts).toEqual([[0, 20], [20, 40], [40, 60]]);
    expect(cuts.flat().filter((_, i) => i % 2 === 0)).toEqual([0, 20, 40]);
  });
});

describe('runBatchCheck leaves nothing behind on any failure (#320)', () => {
  it('a send that fails rejects naming the phase, and the child is dead when it does', async () => {
    let pid;
    const failure = await runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { serialize: () => { throw new RangeError('Invalid string length'); }, onSpawn: (c) => { pid = c.pid; } }).then(() => undefined, (e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/could not serialize 1 items: Invalid string length/);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });

  it('a parser that never answers hits the per-batch timeout, and the child is dead', async () => {
    let pid;
    const started = Date.now();
    const failure = await runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { timeoutMs: 300, onSpawn: (c) => { pid = c.pid; } }).then(() => undefined, (e) => e);
    expect(failure.message).toMatch(/syntax check timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(pid)).toBe(false);
  });

  it('a parser that exits nonzero rejects with its first error line; an empty batch spawns nothing', async () => {
    const failure = await runBatchCheck(process.execPath, ['-e', 'console.error("SyntaxError: boom"); process.exit(3)'], [{ a: 1 }]).then(() => undefined, (e) => e);
    expect(failure.message).toMatch(/syntax check failed: SyntaxError: boom/);
    let spawned = false;
    expect(await runBatchCheck(process.execPath, HANGS, [], { onSpawn: () => { spawned = true; } })).toEqual([]);
    expect(spawned).toBe(false);
  });

  it('an abort signal stops a running parser and rejects once it is gone', async () => {
    const abort = new AbortController();
    let pid;
    const pending = runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { signal: abort.signal, onSpawn: (c) => { pid = c.pid; } });
    abort.abort();
    await expect(pending).rejects.toThrow(/another check failed/);
    expect(alive(pid)).toBe(false);
  });
});

describe('checkAnchors over a source that needs several batches (#320)', () => {
  it('cuts several batches at the default cap and returns every fault, in order, with the late invalid one named', async () => {
    const { dir, faults, doc } = project(60, 57);
    const batches = [];
    const report = await checkAnchors(dir, doc, { onBatch: (b) => batches.push(b) });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.map((b) => [b.from, b.to])).toEqual(cutBatches(faults.map((f, i) => bigSource().length - f.find.length + f.replace.length)));
    expect(report.checked).toBe(60);
    expect(report.results.map((r) => r.faultId)).toEqual(faults.map((f) => f.id));
    report.results.forEach((r, i) => {
      if (i === 57) expect(r).toMatchObject({ status: 'fault-invalid', syntax: { language: 'javascript', status: 'invalid' } });
      else expect(r).toMatchObject({ status: 'ok', syntax: { language: 'javascript', status: 'ok' } });
    });
    expect(report.invalid).toBe(1);
  }, 60_000);

  it('a send failure rejects with a typed error naming the phase, and no parser process is left', async () => {
    const { dir, doc } = project(3, -1);
    const pids = [];
    const failure = await checkAnchors(dir, doc, { serialize: () => { throw new RangeError('Invalid string length'); }, onSpawn: (c) => pids.push(c.pid) }).then(() => undefined, (e) => e);
    expect(failure).toBeInstanceOf(ClaimsError);
    expect(failure.message).toMatch(/syntax check .*could not finish: .*could not serialize 3 items: Invalid string length \(0 of 3 javascript faults checked\)/);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  it('a spent budget stops between batches and says how many faults were checked', async () => {
    const { dir, doc } = project(60, -1);
    const batches = [];
    const failure = await checkAnchors(dir, doc, { budgetMs: 1, onBatch: (b) => batches.push(b) }).then(() => undefined, (e) => e);
    expect(failure).toBeInstanceOf(ClaimsError);
    expect(failure.message).toMatch(/ran out of its 1ms budget after \d+ of 60 faults/);
    expect(batches.length).toBeLessThan(3);
  }, 60_000);

  it('through the CLI a failure is one error line and a nonzero exit, never a hang', () => {
    const { dir, doc } = project(60, -1);
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(doc, null, 2));
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli', 'testguard.mjs'), 'claims', dir, '--check-anchors', '--budget', '1'], { encoding: 'utf8', timeout: 90_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^error: the syntax check of the fault replacements could not finish: .*ran out of its 1ms budget/m);
    expect(r.stderr).not.toMatch(/bug in testguard/);
  }, 120_000);
});

describe('a normal claims file still passes through main()', () => {
  it('exits 0 for a valid project', async () => {
    const { dir, doc } = project(5, -1);
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(doc, null, 2));
    const out = [];
    expect(await main(['claims', dir, '--check-anchors'], { out: (l) => out.push(l), err: (l) => out.push(l) })).toBe(0);
    expect(out.join('\n')).toMatch(/anchor preflight: 5 faults checked, 5 ok, 0 invalid/);
  });
});
