// #320: claims --check-anchors on a large claims file. One message holding every mutated source overran the
// string a parser process can be sent, and the throw left that process waiting for input: a crash, then a hang.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BATCH_CHARS, checkAnchors, checkInBatches, cutBatches, defaultPoolSize, runBatchCheck } from '../src/claims/anchors.mjs';
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
});

// A parser stand-in: reads the batch, then answers, hangs or fails as each item says.
const PARSER = `
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const items = JSON.parse(input);
  if (items.some((i) => i.mode === 'hang')) { setInterval(() => {}, 1000); return; }
  if (items.some((i) => i.mode === 'fail')) { console.error('SyntaxError: stand-in failure'); process.exit(3); }
  setTimeout(() => process.stdout.write(JSON.stringify(items.map((i) => ({ status: 'ok', n: i.n })))), Math.max(...items.map((i) => i.delay ?? 0)));
});`;
const pooled = (candidates, extra = {}) => checkInBatches({ language: 'javascript', command: process.execPath, args: ['-e', PARSER], candidates, sizeOf: () => 10, batchChars: 10, build: (c) => c, ...extra });

describe('a language\'s batches run through a pool (#320)', () => {
  it('the default pool is at most 4 and at least 1', () => {
    expect(defaultPoolSize()).toBeGreaterThanOrEqual(1);
    expect(defaultPoolSize()).toBeLessThanOrEqual(4);
  });

  it('results keep input order when batches finish in another order, and the pool really overlaps them', async () => {
    const delays = [400, 20, 300, 20, 200, 20];
    const started = Date.now();
    const batches = [];
    const results = await pooled(delays.map((delay, n) => ({ n, delay })), { poolSize: 3, onBatch: (b) => batches.push(b) });
    expect(results.map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(batches.map((b) => b.from)).toEqual([0, 1, 2, 3, 4, 5]);
    // serial would take the sum of the delays plus six spawns; three at once is about the longest chain
    expect(Date.now() - started).toBeLessThan(delays.reduce((a, b) => a + b, 0) + 600 - 150);
    const one = await pooled(delays.slice(0, 3).map((delay, n) => ({ n, delay })), { poolSize: 1 });
    expect(one.map((r) => r.n)).toEqual([0, 1, 2]);
  }, 30_000);

  it('one failing batch kills its siblings, every child is gone when it rejects, and it rejects once with the count', async () => {
    const pids = [];
    const started = Date.now();
    const failure = await pooled([{ n: 0, mode: 'hang' }, { n: 1, mode: 'hang' }, { n: 2, mode: 'fail' }, { n: 3, delay: 0 }], { poolSize: 3, onSpawn: (c) => pids.push(c.pid) }).then(() => undefined, (e) => e);
    expect(failure.message).toMatch(/syntax check failed: SyntaxError: stand-in failure \(0 of 4 javascript faults checked\)$/);
    expect(Date.now() - started).toBeLessThan(5_000); // not after the hung siblings' own 10 s
    expect(pids).toHaveLength(3);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  }, 30_000);

  it('an outer abort stops the whole pool', async () => {
    const abort = new AbortController();
    const pids = [];
    const pending = pooled([{ n: 0, mode: 'hang' }, { n: 1, mode: 'hang' }], { poolSize: 2, signal: abort.signal, onSpawn: (c) => pids.push(c.pid) });
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    await expect(pending).rejects.toThrow(/another check failed/);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  }, 30_000);
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
