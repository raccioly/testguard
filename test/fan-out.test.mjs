// The pure rules of `probe --fault-workers` (issue #237). Cheap on purpose:
// these are the defenders of the fan-out claims, run N times by the self-probe.
import { describe, it, expect } from 'vitest';
import { createBusyClock, needsSerialRemeasure, orderedEmitter, parseFaultWorkers, runPool, singleFlight } from '../src/probe/fan-out.mjs';
import { sameFaultWorkers, sameWorkerPolicy, reusableRun } from '../src/probe/probe.mjs';
import { contentionWarning, fanOutWarning } from '../src/probe/contention.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('parseFaultWorkers', () => {
  it('defaults to one and accepts only positive safe integers', () => {
    expect(parseFaultWorkers(undefined)).toBe(1);
    expect(parseFaultWorkers('4')).toBe(4);
    expect(parseFaultWorkers(2)).toBe(2);
    for (const bad of ['0', '-1', '2.5', 'two', '', 0, 9007199254740992]) expect(parseFaultWorkers(bad)).toBeNull();
  });
});

describe('needsSerialRemeasure', () => {
  it('re-measures a timeout and an inconsistent probe, nothing else', () => {
    expect(needsSerialRemeasure({ verdict: 'timeout', detail: { reason: 'test-timed-out' } })).toBe(true);
    expect(needsSerialRemeasure({ verdict: 'flaky-defender', detail: { reason: 'inconsistent-probe' } })).toBe(true);
    // A red baseline was measured before the fan-out, alone: never contended.
    expect(needsSerialRemeasure({ verdict: 'flaky-defender', detail: { reason: 'defenders-not-green' } })).toBe(false);
    for (const verdict of ['killed', 'survived', 'nocover', 'unverifiable', 'fault-invalid']) {
      expect(needsSerialRemeasure({ verdict, detail: {} })).toBe(false);
    }
    // A reused verdict was not measured by this run at all.
    expect(needsSerialRemeasure({ verdict: 'timeout', detail: {}, reusedFrom: 'run-1' })).toBe(false);
    expect(needsSerialRemeasure(undefined)).toBe(false);
  });
});

describe('orderedEmitter', () => {
  it('publishes in index order whatever order results settle in', () => {
    const seen = [];
    const e = orderedEmitter(4, (value, i) => seen.push([i, value]));
    e.settle(2, 'c');
    e.settle(3, 'd');
    expect(seen).toEqual([]);
    e.settle(0, 'a');
    expect(seen).toEqual([[0, 'a']]);
    e.settle(1, 'b');
    expect(seen).toEqual([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']]);
    expect(e.emitted).toBe(4);
  });

  it('an unsettled index holds back everything after it', () => {
    const seen = [];
    const e = orderedEmitter(3, (value) => seen.push(value));
    e.settle(0, 'a');
    e.settle(2, 'c');
    expect(seen).toEqual(['a']);
    e.settle(1, 'b');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('refuses to re-emit or to accept an index out of range', () => {
    const e = orderedEmitter(1, () => {});
    e.settle(0, 'a');
    expect(() => e.settle(0, 'again')).toThrow(/already emitted/);
    expect(() => e.settle(1, 'x')).toThrow(RangeError);
  });
});

describe('runPool', () => {
  it('never runs more items than slots, and never two items in one slot', async () => {
    const busy = new Set();
    let peak = 0;
    const order = [];
    await runPool([0, 1, 2, 3, 4, 5, 6], ['A', 'B', 'C'], async (item, slot) => {
      expect(busy.has(slot)).toBe(false);
      busy.add(slot);
      peak = Math.max(peak, busy.size);
      order.push(item);
      for (let i = 0; i < 1 + (item % 3); i++) await tick();
      busy.delete(slot);
    });
    expect(peak).toBe(3);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]); // dispatched in index order
  });

  it('lets in-flight items finish, dispatches nothing new, and throws the lowest-index failure', async () => {
    const finished = [];
    const started = [];
    const failure = runPool([0, 1, 2, 3, 4, 5], ['A', 'B', 'C'], async (item) => {
      started.push(item);
      if (item === 2) { await tick(); throw new Error('two'); }
      if (item === 1) { for (let i = 0; i < 5; i++) await tick(); throw new Error('one'); }
      for (let i = 0; i < 8; i++) await tick();
      finished.push(item);
    });
    await expect(failure).rejects.toThrow('one');
    expect(finished).toContain(0); // still running when item 2 failed: allowed to restore
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
  });

  it('a throw from beforeEach is a failure at that index', async () => {
    const ran = [];
    await expect(runPool([0, 1, 2], ['A'], async (item) => { ran.push(item); }, {
      beforeEach: (i) => { if (i === 1) throw new Error('budget'); },
    })).rejects.toThrow('budget');
    expect(ran).toEqual([0]);
  });
});

describe('createBusyClock', () => {
  it('charges serial invocations their sum and overlapping ones their union', () => {
    let t = 0;
    const clock = createBusyClock(() => t);
    clock.start(); t = 10; clock.stop(); // [0,10)
    t = 20; clock.start(); t = 25; clock.stop(); // [20,25)
    expect(clock.totalMs).toBe(15);
    // Two overlapping invocations, [30,50) and [40,70): 40 of wall time, not 50.
    t = 30; clock.start();
    t = 40; clock.start();
    t = 50; clock.stop();
    t = 70; clock.stop();
    expect(clock.totalMs).toBe(55);
    expect(clock.active).toBe(0);
    expect(() => clock.stop()).toThrow(/more often/);
  });
});

describe('singleFlight', () => {
  it('concurrent askers of one key share one computation', async () => {
    const cache = new Map();
    let calls = 0;
    const compute = async () => { calls++; await tick(); return 'answer'; };
    const [a, b] = await Promise.all([singleFlight(cache, 'k', compute), singleFlight(cache, 'k', compute)]);
    expect([a, b, calls]).toEqual(['answer', 'answer', 1]);
    expect(await singleFlight(cache, 'k', compute)).toBe('answer');
    expect(calls).toBe(1);
  });

  it('a failure is not cached', async () => {
    const cache = new Map();
    await expect(singleFlight(cache, 'k', async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(await singleFlight(cache, 'k', async () => 'yes')).toBe('yes');
  });
});

describe('fault workers join the reuse policy', () => {
  it('a fan-out never stands in for a run that asked for one fault at a time; serial stands in for any (#270)', () => {
    expect(sameFaultWorkers(undefined, 1)).toBe(true);
    expect(sameFaultWorkers(1, 1)).toBe(true);
    expect(sameFaultWorkers(undefined, 4)).toBe(true);
    expect(sameFaultWorkers(4, 4)).toBe(true);
    expect(sameFaultWorkers(4, 1, { serialRequested: true })).toBe(false);
    expect(sameFaultWorkers(2, 4)).toBe(true);
    expect(sameWorkerPolicy({ workers: 1, serial: true, faultWorkers: 4 }, { workers: 1, serialRequested: true })).toBe(false);
    expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 1, faultWorkers: 4 })).toBe(true);
    // A custom command's own policy is opaque, but the fan-out is ours.
    expect(sameWorkerPolicy({ faultWorkers: 2 }, { runnerCommand: 'x', serialRequested: true })).toBe(false);
    expect(sameWorkerPolicy({ faultWorkers: 2 }, { runnerCommand: 'x' })).toBe(true);
    expect(sameWorkerPolicy({}, { runnerCommand: 'x', faultWorkers: 2 })).toBe(true);
  });

  it('reusableRun refuses evidence measured under a fan-out for a probe that asked for serial', () => {
    const instrument = { toolVersion: '1.0.0', digest: 'd' };
    const runner = { name: 'vitest', version: '5', source: 'project' };
    const previous = (faultWorkers) => ({ tool: { version: '1.0.0' }, run: { confirmRuns: 3, workers: 1, serial: true, runner, instrument, ...(faultWorkers ? { faultWorkers } : {}) } });
    const ask = { confirmRuns: 3, workers: 1, serial: true, runner, instrument };
    expect(reusableRun(previous(), ask)).toBe(true);
    expect(reusableRun(previous(4), { ...ask, serialRequested: true })).toBe(false);
    expect(reusableRun(previous(4), { ...ask, faultWorkers: 4 })).toBe(true);
  });
});

describe('contention advice accounts for the fan-out', () => {
  const c = { detected: true, runners: [{ pid: 7, command: 'vitest' }] };
  it('names --fault-workers when the probe fans out, and not otherwise', () => {
    expect(contentionWarning(c, { faultWorkers: 3 })).toMatch(/lower --fault-workers 3/);
    expect(contentionWarning(c, { faultWorkers: 3 })).toMatch(/re-measured serially/);
    expect(contentionWarning(c, {})).not.toMatch(/fault-workers/);
  });

  it('warns when the fan-out alone oversubscribes the machine', () => {
    expect(fanOutWarning({ faultWorkers: 1, cpus: 1 })).toBeUndefined();
    expect(fanOutWarning({ faultWorkers: 4, cpus: 8 })).toBeUndefined();
    expect(fanOutWarning({ faultWorkers: 4, workers: 4, serial: false, cpus: 8 })).toMatch(/16 concurrent test processes on 8 available CPUs/);
    expect(fanOutWarning({ faultWorkers: 4, workers: 4, serial: false, cpus: 8 })).toMatch(/lower --fault-workers to 2/);
    expect(fanOutWarning({ faultWorkers: 3, cpus: 2 })).toMatch(/lower --fault-workers to 2/);
  });
});

describe('preconditions', () => {
  it('probe refuses a fan-out in place and a count that is not a positive integer, before touching anything', async () => {
    const { probe } = await import('../src/probe/probe.mjs');
    const { UsageError } = await import('../src/probe/precondition-error.mjs');
    const nowhere = { projectDir: '/nonexistent/testguard-fan-out', claims: { claims: [] } };
    // Wrong whatever the repository holds, so usage (exit 3), not a precondition.
    await expect(probe({ ...nowhere, mode: 'in-place', faultWorkers: 2 })).rejects.toThrow(UsageError);
    await expect(probe({ ...nowhere, mode: 'in-place', faultWorkers: 2 })).rejects.toThrow(/drop --in-place/);
    await expect(probe({ ...nowhere, faultWorkers: 0 })).rejects.toThrow(/fault workers must be a positive safe integer/);
    await expect(probe({ ...nowhere, faultWorkers: 1.5 })).rejects.toThrow(/fault workers must be a positive safe integer/);
  });

  it('the CLI refuses them with exit 3', async () => {
    const { probeCommand } = await import('../src/commands/probe.mjs');
    const err = [];
    const io = { out: () => {}, err: (line) => err.push(line) };
    const values = { confirm: '3', budget: '120000', workers: '1', runner: 'auto' };
    expect(await probeCommand({ projectDir: '/nonexistent', values: { ...values, 'fault-workers': '2', 'in-place': true }, version: '0.0.0' }, io)).toBe(3);
    expect(await probeCommand({ projectDir: '/nonexistent', values: { ...values, 'fault-workers': 'many' }, version: '0.0.0' }, io)).toBe(3);
    expect(err).toEqual([
      '--fault-workers above 1 needs one scratch worktree per fault in flight; drop --in-place',
      '--fault-workers must be a positive integer or auto (got "many")',
    ]);
  });
});
