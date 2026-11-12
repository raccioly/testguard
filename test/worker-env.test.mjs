// TESTGUARD_WORKER (raccioly/testguard#287): every runner process learns the
// index of the scratch tree it runs in, so a suite can derive a port of its own.
import { it, expect } from 'vitest';
import { withWorker, workerEnv } from '../src/probe/worker-env.mjs';
import { runProcess } from '../src/probe/runners/shared.mjs';

it('is 0 outside any tree, the tree index inside one, and never leaks between concurrent trees', async () => {
  expect(workerEnv()).toEqual({ TESTGUARD_WORKER: '0' });
  const seen = await Promise.all([3, 1].map((i) => withWorker(i, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5 * i));
    return workerEnv().TESTGUARD_WORKER;
  })));
  expect(seen).toEqual(['3', '1']);
});

it('reaches the runner process the probe spawns', async () => {
  const script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, worker: process.env.TESTGUARD_WORKER }))";
  const result = await withWorker(2, () => runProcess({ projectDir: process.cwd(), files: [], budgetMs: 20_000, argv: (files, out) => [process.execPath, '-e', script, out], parse: (doc) => ({ run: { outcome: 'pass', durationMs: 0 }, worker: (typeof doc === 'string' ? JSON.parse(doc) : doc).worker }) }));
  expect(result.worker ?? result.run?.worker).toBe('2');
}, 30_000);

// #293: two probe commands on one machine never hand out the same index.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorkerSlot, withCommandWorkers, workerBaseFromEnv, WORKER_SLOT_STRIDE } from '../src/probe/worker-env.mjs';

const slotDir = () => mkdtempSync(join(tmpdir(), 'tg-worker-slots-'));

it('two concurrent commands get different bases; a lone command still starts at 0', async () => {
  const dir = slotDir();
  try {
    let releaseFirst;
    const held = new Promise((resolve) => { releaseFirst = resolve; });
    const seen = [];
    const first = withCommandWorkers(async () => { seen.push(['a', withWorker(1, () => workerEnv().TESTGUARD_WORKER)]); await held; }, { env: {}, dir });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await withCommandWorkers(async () => { seen.push(['b', withWorker(1, () => workerEnv().TESTGUARD_WORKER)]); }, { env: {}, dir });
    releaseFirst();
    await first;
    expect(seen).toEqual([['a', '1'], ['b', String(WORKER_SLOT_STRIDE + 1)]]);
    // Both released: the next command is slot 0 again, and no lock is left behind.
    expect(readdirSync(dir)).toEqual([]);
    await withCommandWorkers(async () => { expect(workerEnv().TESTGUARD_WORKER).toBe('0'); }, { env: {}, dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('takes over a slot whose owner is gone, never one a live command holds', () => {
  const dir = slotDir();
  try {
    writeFileSync(join(dir, 'slot-0.lock'), JSON.stringify({ pid: 999999, host: 'here' }));
    writeFileSync(join(dir, 'slot-1.lock'), JSON.stringify({ pid: 4242, host: 'here' }));
    const claim = claimWorkerSlot(dir, { host: 'here', alive: (pid) => pid === 4242 });
    expect(claim.slot).toBe(0);
    const next = claimWorkerSlot(dir, { host: 'here', alive: (pid) => pid === 4242 || pid === process.pid });
    expect(next.slot).toBe(2);
    claim.release(); next.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('TESTGUARD_WORKER_BASE sets the base and holds no slot; anything but a non-negative integer is refused', async () => {
  const dir = slotDir();
  try {
    await withCommandWorkers(async () => { expect(withWorker(2, () => workerEnv().TESTGUARD_WORKER)).toBe('9'); }, { env: { TESTGUARD_WORKER_BASE: '7' }, dir });
    expect(readdirSync(dir)).toEqual([]);
    for (const bad of ['-1', '1.5', 'two']) expect(() => workerBaseFromEnv({ TESTGUARD_WORKER_BASE: bad })).toThrow(/non-negative integer/);
    expect(workerBaseFromEnv({})).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('a scratch root that cannot hold a lock file starts at 0, unheld, never a failure', async () => {
  const dir = slotDir();
  try {
    writeFileSync(join(dir, 'not-a-dir'), 'x');
    const claim = claimWorkerSlot(join(dir, 'not-a-dir', 'slots'));
    expect(claim).toMatchObject({ slot: 0, held: false });
    await withCommandWorkers(async () => { expect(workerEnv().TESTGUARD_WORKER).toBe('0'); }, { env: {}, dir: join(dir, 'not-a-dir', 'slots') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
