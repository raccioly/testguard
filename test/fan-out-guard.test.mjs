// The pure rules that make a default-on fan-out sound (issue #270): how many
// faults run at once when nobody said, which runs were measured alone, when a
// kill-shaped fault must take its last run alone, and when a contended answer
// is not believed. Cheap on purpose: these defend the self-probe's fan-out
// claims and are run N times there.
import { describe, it, expect } from 'vitest';
import {
  autoFaultWorkers, resolveFaultWorkers, createOverlapTracker, deferLastRun, mustConfirmAlone, aloneDisagrees,
  needsSerialRemeasure, contentionRoundDown,
} from '../src/probe/fan-out.mjs';
import { sameFaultWorkers, reusableRun } from '../src/probe/probe.mjs';

const fail = { outcome: 'fail', tests: 1, failures: 1, assertionFailures: 1, durationMs: 1 };
const pass = { outcome: 'pass', tests: 1, failures: 0, durationMs: 1 };

describe('autoFaultWorkers', () => {
  it('is half the available CPUs, at least one and at most four', () => {
    expect([1, 2, 3, 4, 5, 7, 8, 9, 18, 64].map(autoFaultWorkers)).toEqual([1, 1, 1, 2, 2, 3, 4, 4, 4, 4]);
  });

  it('is one when the CPU count is unknown or absurd', () => {
    for (const cpus of [undefined, 0, -2, Number.NaN, 2.5]) expect(autoFaultWorkers(cpus)).toBe(1);
  });
});

describe('resolveFaultWorkers', () => {
  const base = { cpus: 8, env: {} };
  it('defaults to auto, from the machine', () => {
    expect(resolveFaultWorkers(base)).toEqual({ faultWorkers: 4, source: 'auto', cpus: 8 });
    expect(resolveFaultWorkers({ ...base, cpus: 2 })).toEqual({ faultWorkers: 1, source: 'auto', cpus: 2 });
  });

  it('a flag beats the environment, and the environment beats auto', () => {
    expect(resolveFaultWorkers({ ...base, flag: '3', env: { TESTGUARD_FAULT_WORKERS: '2' } })).toEqual({ faultWorkers: 3, source: 'flag' });
    expect(resolveFaultWorkers({ ...base, env: { TESTGUARD_FAULT_WORKERS: '2' } })).toEqual({ faultWorkers: 2, source: 'env' });
    expect(resolveFaultWorkers({ ...base, flag: 'auto', env: { TESTGUARD_FAULT_WORKERS: '2' } })).toEqual({ faultWorkers: 4, source: 'auto', cpus: 8 });
    expect(resolveFaultWorkers({ ...base, env: { TESTGUARD_FAULT_WORKERS: 'auto' } })).toEqual({ faultWorkers: 4, source: 'auto', cpus: 8 });
  });

  it('--serial is one fault at a time, and the explicit flag is the only switch', () => {
    expect(resolveFaultWorkers({ ...base, serial: true })).toEqual({ faultWorkers: 1, source: 'serial' });
    expect(resolveFaultWorkers({ ...base, serial: true, env: { TESTGUARD_FAULT_WORKERS: '4' } })).toEqual({ faultWorkers: 1, source: 'serial' });
    expect(resolveFaultWorkers({ ...base, serial: true, flag: '1' })).toEqual({ faultWorkers: 1, source: 'serial' });
    expect(resolveFaultWorkers({ ...base, serial: true, flag: '3' }).error).toMatch(/--serial.*--fault-workers 3/);
  });

  it('in place resolves auto to one tree, and refuses an explicit fan-out', () => {
    expect(resolveFaultWorkers({ ...base, inPlace: true })).toEqual({ faultWorkers: 1, source: 'in-place' });
    expect(resolveFaultWorkers({ ...base, inPlace: true, env: { TESTGUARD_FAULT_WORKERS: '3' } })).toEqual({ faultWorkers: 1, source: 'in-place' });
    expect(resolveFaultWorkers({ ...base, inPlace: true, flag: '2' }).error).toMatch(/drop --in-place/);
    expect(resolveFaultWorkers({ ...base, inPlace: true, flag: '1' })).toEqual({ faultWorkers: 1, source: 'flag' });
  });

  it('a bad value is a usage error naming where it came from', () => {
    expect(resolveFaultWorkers({ ...base, flag: '0' }).error).toMatch(/--fault-workers/);
    expect(resolveFaultWorkers({ ...base, flag: 'two' }).error).toMatch(/--fault-workers/);
    expect(resolveFaultWorkers({ ...base, env: { TESTGUARD_FAULT_WORKERS: '-1' } }).error).toMatch(/TESTGUARD_FAULT_WORKERS/);
    // An empty variable is an unset one.
    expect(resolveFaultWorkers({ ...base, env: { TESTGUARD_FAULT_WORKERS: '' } }).source).toBe('auto');
  });
});

describe('contentionRoundDown', () => {
  it('halves an automatic count when other runners are already busy, never an explicit one', () => {
    expect(contentionRoundDown({ faultWorkers: 4, source: 'auto' }, true)).toBe(2);
    expect(contentionRoundDown({ faultWorkers: 3, source: 'auto' }, true)).toBe(1);
    expect(contentionRoundDown({ faultWorkers: 1, source: 'auto' }, true)).toBe(1);
    expect(contentionRoundDown({ faultWorkers: 4, source: 'auto' }, false)).toBe(4);
    expect(contentionRoundDown({ faultWorkers: 4, source: 'flag' }, true)).toBe(4);
    expect(contentionRoundDown({ faultWorkers: 4, source: 'env' }, true)).toBe(4);
  });
});

describe('createOverlapTracker', () => {
  it('a run is alone only if no other measurement was in flight at any moment of it', () => {
    const t = createOverlapTracker();
    const a = t.enter();
    const solo = t.runStarted();
    expect(solo()).toBe(true); // nothing else ever entered
    const b = t.enter();
    const shared = t.runStarted(); // b is in flight
    t.leave(b);
    expect(shared()).toBe(false);
    const late = t.runStarted(); // alone at its start…
    const c = t.enter(); // …but another measurement began during it
    t.leave(c);
    expect(late()).toBe(false);
    const after = t.runStarted();
    expect(after()).toBe(true);
    t.leave(a);
    expect(t.active).toBe(0);
  });

  it('a measurement is contended once any other measurement overlaps it, whichever began first', () => {
    const t = createOverlapTracker();
    const a = t.enter();
    expect(a.contended).toBe(false);
    const b = t.enter();
    expect(a.contended).toBe(true);
    expect(b.contended).toBe(true);
    t.leave(a);
    t.leave(b);
    const c = t.enter();
    expect(c.contended).toBe(false);
    t.leave(c);
  });

  it('refuses to leave more often than it entered', () => {
    const t = createOverlapTracker();
    expect(() => t.leave(t.enter()) || t.leave({})).toThrow();
  });
});

describe('deferLastRun', () => {
  it('stops a kill-shaped fault before its last run when no run so far was alone and another fault is in flight', () => {
    expect(deferLastRun([fail, fail], 3, true)).toBe(true);
    // N = 1: the only run is the last, so the whole measurement is alone.
    expect(deferLastRun([], 1, true)).toBe(true);
  });

  it('runs on when nothing else is in flight, the next run is not the last, a run was alone, or a run was not a kill', () => {
    expect(deferLastRun([fail, fail], 3, false)).toBe(false);
    expect(deferLastRun([], 1, false)).toBe(false);
    expect(deferLastRun([fail], 3, true)).toBe(false);
    expect(deferLastRun([fail, { ...fail, alone: true }], 3, true)).toBe(false);
    expect(deferLastRun([fail, pass], 3, true)).toBe(false);
    expect(deferLastRun([{ outcome: 'error' }, fail], 3, true)).toBe(false);
  });
});

describe('mustConfirmAlone', () => {
  it('N kills with not one alone cannot be reported', () => {
    expect(mustConfirmAlone([fail, fail, fail], 3)).toBe(true);
    expect(mustConfirmAlone([fail], 1)).toBe(true);
  });

  it('one run alone, a run that was not a kill, or fewer than N runs is something else', () => {
    expect(mustConfirmAlone([fail, fail, { ...fail, alone: true }], 3)).toBe(false);
    expect(mustConfirmAlone([fail, fail, pass], 3)).toBe(false);
    expect(mustConfirmAlone([fail, fail], 3)).toBe(false);
  });
});

describe('aloneDisagrees', () => {
  it('a run alone that passes after a contended red run says the red was the neighbours', () => {
    expect(aloneDisagrees([fail, fail, { ...pass, alone: true }])).toBe(true);
    expect(aloneDisagrees([{ ...pass, alone: true }, fail])).toBe(true);
    expect(aloneDisagrees([{ outcome: 'timeout' }, { ...pass, alone: true }])).toBe(true);
  });

  it('agreement, all-contended and all-alone runs are not a disagreement', () => {
    expect(aloneDisagrees([fail, fail, { ...fail, alone: true }])).toBe(false);
    expect(aloneDisagrees([fail, pass, fail])).toBe(false);
    expect(aloneDisagrees([{ ...fail, alone: true }, { ...pass, alone: true }])).toBe(false);
    expect(aloneDisagrees([pass, { ...pass, alone: true }])).toBe(false);
  });
});

describe('needsSerialRemeasure, for the outcomes contention can manufacture', () => {
  it('re-measures a kill attributed to undeclared tests and a suite that failed to load', () => {
    expect(needsSerialRemeasure({ verdict: 'survived', detail: { reason: 'killed-by-undeclared-tests' } })).toBe(true);
    expect(needsSerialRemeasure({ verdict: 'fault-invalid', detail: { reason: 'suite-failed-to-load' } })).toBe(true);
    // A replacement that does not compile is a property of the text, not of the load.
    expect(needsSerialRemeasure({ verdict: 'fault-invalid', detail: { reason: 'replacement-does-not-compile' } })).toBe(false);
    expect(needsSerialRemeasure({ verdict: 'survived', detail: {} })).toBe(false);
  });
});

describe('reuse across fan-out widths', () => {
  it('any guarded fan-out stands in for any other, and never for a run that asked for one fault at a time', () => {
    expect(sameFaultWorkers(2, 4)).toBe(true);
    expect(sameFaultWorkers(4, 2)).toBe(true);
    expect(sameFaultWorkers(4, 1)).toBe(true); // auto resolved to one: nobody asked for serial
    expect(sameFaultWorkers(4, 1, { serialRequested: true })).toBe(false);
    expect(sameFaultWorkers(undefined, 1, { serialRequested: true })).toBe(true);
    expect(sameFaultWorkers(undefined, 4)).toBe(true);
  });

  it('reusableRun carries the request through', () => {
    const instrument = { toolVersion: '1.0.0', digest: 'd' };
    const runner = { name: 'vitest', version: '5', source: 'project' };
    const previous = { tool: { version: '1.0.0' }, run: { confirmRuns: 3, workers: 1, serial: true, runner, instrument, faultWorkers: 4 } };
    const ask = { confirmRuns: 3, workers: 1, serial: true, runner, instrument };
    expect(reusableRun(previous, { ...ask, faultWorkers: 2 })).toBe(true);
    expect(reusableRun(previous, ask)).toBe(true);
    expect(reusableRun(previous, { ...ask, serialRequested: true })).toBe(false);
  });
});
