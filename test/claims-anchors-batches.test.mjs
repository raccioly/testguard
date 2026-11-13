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
const T = 5_000; // no test here may wait on a timeout to fail: each has seconds, and each awaited call a bound
/** The promise, or a failure that says it never settled: a fault that removes a stop must not cost a long wait. */
const bounded = (promise, ms = 1_500) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const settled = (promise) => bounded(promise).then(() => undefined, (e) => e);

const LINES = 200;
const NUM = (i) => String(i).padStart(5, '0');
/** ~10 KB of valid JavaScript with a unique anchor per line. */
const bigSource = () => Array.from({ length: LINES }, (_, i) => `const value_${NUM(i)} = ${i}; // padding padding padding`).join('\n') + '\n';
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

describe('runBatchCheck leaves nothing behind on any failure (#320)', { timeout: T }, () => {
  it('a send that fails rejects naming the phase, and the child is dead when it does', async () => {
    let pid;
    const failure = await settled(runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { serialize: () => { throw new RangeError('Invalid string length'); }, onSpawn: (c) => { pid = c.pid; } }));
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/could not serialize 1 items: Invalid string length/);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });

  it('a parser that never answers hits the per-batch timeout, and the child is dead', async () => {
    let pid;
    const failure = await settled(runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { timeoutMs: 100, onSpawn: (c) => { pid = c.pid; } }));
    expect(failure.message).toMatch(/syntax check timed out after 100ms/);
    expect(alive(pid)).toBe(false);
  });

  it('a parser that exits nonzero rejects with its first error line; an empty batch spawns nothing', async () => {
    const failure = await settled(runBatchCheck(process.execPath, ['-e', 'console.error("SyntaxError: boom"); process.exit(3)'], [{ a: 1 }], { timeoutMs: 1_000 }));
    expect(failure.message).toMatch(/syntax check failed: SyntaxError: boom/);
    let spawned = false;
    expect(await bounded(runBatchCheck(process.execPath, HANGS, [], { onSpawn: () => { spawned = true; } }))).toEqual([]);
    expect(spawned).toBe(false);
  });

  it('an abort signal stops a running parser and rejects once it is gone', async () => {
    const abort = new AbortController();
    let pid;
    const pending = runBatchCheck(process.execPath, HANGS, [{ a: 1 }], { signal: abort.signal, timeoutMs: 1_000, onSpawn: (c) => { pid = c.pid; } });
    abort.abort();
    expect((await settled(pending)).message).toMatch(/another check failed/);
    expect(alive(pid)).toBe(false);
  });
});

describe('checkAnchors over a source that needs several batches (#320)', { timeout: T }, () => {
  it('cuts several batches and returns every fault, in order, with the late invalid one named', async () => {
    const { dir, faults, doc } = project(12, 10);
    const batchChars = 3 * bigSource().length + 50; // three faults to a batch, four batches
    const batches = [];
    const report = await bounded(checkAnchors(dir, doc, { batchChars, onBatch: (b) => batches.push(b) }), 4_000);
    expect(batches.map((b) => [b.from, b.to]).sort((x, y) => x[0] - y[0])).toEqual(cutBatches(faults.map((f) => bigSource().length - f.find.length + f.replace.length), batchChars));
    expect(batches.length).toBeGreaterThanOrEqual(4);
    expect(report.checked).toBe(12);
    expect(report.results.map((r) => r.faultId)).toEqual(faults.map((f) => f.id));
    report.results.forEach((r, i) => {
      if (i === 10) expect(r).toMatchObject({ status: 'fault-invalid', syntax: { language: 'javascript', status: 'invalid' } });
      else expect(r).toMatchObject({ status: 'ok', syntax: { language: 'javascript', status: 'ok' } });
    });
    expect(report.invalid).toBe(1);
  });

  it('a send failure rejects with a typed error naming the phase, and no parser process is left', async () => {
    const { dir, doc } = project(3, -1);
    const pids = [];
    const failure = await settled(checkAnchors(dir, doc, { serialize: () => { throw new RangeError('Invalid string length'); }, onSpawn: (c) => pids.push(c.pid) }));
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
const pooled = (candidates, extra = {}) => checkInBatches({ language: 'javascript', command: process.execPath, args: ['-e', PARSER], candidates, sizeOf: () => 10, batchChars: 10, build: (c) => c, timeoutMs: 400, ...extra });

describe('a language\'s batches run through a pool (#320)', { timeout: T }, () => {
  it('the default pool is at most 4 and at least 1', () => {
    expect(defaultPoolSize()).toBeGreaterThanOrEqual(1);
    expect(defaultPoolSize()).toBeLessThanOrEqual(4);
  });

  it('results keep input order when batches finish in another order, and three parsers really run at once', async () => {
    const delays = [60, 5, 40, 5, 20];
    let inFlight = 0;
    let most = 0;
    const batches = [];
    const results = await bounded(pooled(delays.map((delay, n) => ({ n, delay })), {
      poolSize: 3,
      onBatch: (b) => batches.push(b),
      onSpawn: (child) => { inFlight++; most = Math.max(most, inFlight); child.on('close', () => { inFlight--; }); },
    }), 4_000);
    expect(results.map((r) => r.n)).toEqual([0, 1, 2, 3, 4]);
    expect(batches.map((b) => b.from)).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(3);
  });

  it('one failing batch kills its siblings, every child is gone when it rejects, and it rejects once with the count', async () => {
    const pids = [];
    // the siblings hang for 4 s unless the failure stops them; 2.5 s leaves a loaded runner room to start three processes
    const failure = await bounded(pooled([{ n: 0, mode: 'hang' }, { n: 1, mode: 'hang' }, { n: 2, mode: 'fail' }, { n: 3, delay: 0 }], { poolSize: 3, timeoutMs: 4_000, onSpawn: (c) => pids.push(c.pid) }), 2_500).then(() => undefined, (e) => e);
    expect(failure.message).toMatch(/syntax check failed: SyntaxError: stand-in failure \(0 of 4 javascript faults checked\)$/); // not a sibling's timeout
    expect(pids).toHaveLength(3);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  it('an outer abort stops the whole pool', async () => {
    const abort = new AbortController();
    const pids = [];
    const pending = pooled([{ n: 0, mode: 'hang' }, { n: 1, mode: 'hang' }], { poolSize: 2, timeoutMs: 1_200, signal: abort.signal, onSpawn: (c) => pids.push(c.pid) });
    for (let i = 0; i < 40 && pids.length < 2; i++) await new Promise((r) => setTimeout(r, 5)); // both parsers are up (bounded: a pool of one never gets there)
    abort.abort();
    expect((await settled(pending)).message).toMatch(/another check failed/);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});

describe('a normal claims file still passes through main()', { timeout: T }, () => {
  it('exits 0 for a valid project', async () => {
    const { dir, doc } = project(2, -1);
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(doc, null, 2));
    const out = [];
    expect(await main(['claims', dir, '--check-anchors'], { out: (l) => out.push(l), err: (l) => out.push(l) })).toBe(0);
    expect(out.join('\n')).toMatch(/anchor preflight: 2 faults checked, 2 ok, 0 invalid/);
  });
});
