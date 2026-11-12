import { isKillRun } from './kill-kind.mjs';

/**
 * The pure pieces of `probe --fault-workers` (issue #237): how faults are
 * handed to scratch trees, in what order their records are published, which
 * verdicts a fan-out may not report without a serial re-measure, and how
 * runner time is charged when invocations overlap.
 *
 * Kept free of I/O so each rule has a cheap unit defender; `probe.mjs` only
 * wires them to real runners and real worktrees.
 */

/** A positive safe integer, or null. `--fault-workers` and the API share it. */
export function parseFaultWorkers(value) {
  if (value === undefined) return 1;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** The most faults `auto` ever runs at once (issue #270). */
export const AUTO_FAULT_WORKERS_CAP = 4;

/**
 * `--fault-workers auto`: half the CPUs this process may use, at least one and
 * at most four. Half, because every fault in flight is a whole test runner
 * with its own transform and worker threads beside TestGuard and the OS, and a
 * timeout measured under self-inflicted load is re-measured alone, which costs
 * more than the fan-out saved. At most four, because `availableParallelism()`
 * does not see a container's CPU quota, and because every kill measured under
 * a fan-out still takes one run alone: past four, those runs dominate.
 */
export function autoFaultWorkers(cpus) {
  if (!Number.isSafeInteger(cpus) || cpus < 1) return 1;
  return Math.max(1, Math.min(AUTO_FAULT_WORKERS_CAP, Math.floor(cpus / 2)));
}

/**
 * How many faults the CLI probes at once, and why. Precedence: `--serial`
 * (the explicit flag only — the derived "one runner worker" of the default is
 * not a request), then `--fault-workers`, then `TESTGUARD_FAULT_WORKERS`, then
 * auto. `--in-place` has one tree, so auto resolves to one there and an
 * explicit fan-out is refused. Returns `{ faultWorkers, source, cpus? }` or
 * `{ error }` (a usage error).
 */
export function resolveFaultWorkers({ flag, env = {}, serial = false, inPlace = false, cpus }) {
  const read = (value, name) => {
    if (value === 'auto') return { auto: true };
    const n = parseFaultWorkers(value);
    return n === null ? { error: `${name} must be a positive integer or auto (got ${JSON.stringify(value)})` } : { n };
  };
  const envValue = env.TESTGUARD_FAULT_WORKERS === '' ? undefined : env.TESTGUARD_FAULT_WORKERS;
  const asked = flag !== undefined ? { ...read(flag, '--fault-workers'), source: 'flag' }
    : envValue !== undefined ? { ...read(envValue, 'TESTGUARD_FAULT_WORKERS'), source: 'env' }
      : { auto: true };
  if (asked.error) return { error: asked.error };
  if (serial) {
    if (asked.source === 'flag' && !asked.auto && asked.n > 1) return { error: `--serial probes one fault at a time; it cannot be combined with --fault-workers ${asked.n}` };
    return { faultWorkers: 1, source: 'serial' };
  }
  if (inPlace) {
    if (asked.source === 'flag' && !asked.auto && asked.n > 1) return { error: '--fault-workers above 1 needs one scratch worktree per fault in flight; drop --in-place' };
    if (asked.source === 'flag' && !asked.auto) return { faultWorkers: 1, source: 'flag' };
    return { faultWorkers: 1, source: 'in-place' };
  }
  if (asked.auto) return { faultWorkers: autoFaultWorkers(cpus), source: 'auto', cpus };
  return { faultWorkers: asked.n, source: asked.source };
}

/**
 * Other test runners were already busy when the probe started: an automatic
 * count is halved, because the machine is not the probe's to divide. A count
 * somebody chose is theirs.
 */
export function contentionRoundDown({ faultWorkers, source }, detected) {
  return source === 'auto' && detected ? Math.max(1, Math.floor(faultWorkers / 2)) : faultWorkers;
}

/**
 * Which runs were measured with nothing else in flight. A measurement (one
 * fault, from apply to restore) `enter`s and `leave`s; `runStarted()` returns a
 * function that, called when the run ends, says whether the run was alone:
 * no other measurement was in flight when it began, and none began before it
 * ended. Counters only, so the answer cannot depend on scheduling order.
 */
export function createOverlapTracker() {
  const inFlight = new Set();
  let entered = 0;
  return {
    /** A measurement begins. Its token's `contended` turns true once any other measurement overlaps it. */
    enter() {
      const token = { left: false, contended: inFlight.size > 0 };
      for (const other of inFlight) other.contended = true;
      inFlight.add(token);
      entered++;
      return token;
    },
    leave(token) {
      if (!token || token.left || !inFlight.has(token)) throw new Error('overlap tracker left more often than entered');
      token.left = true;
      inFlight.delete(token);
    },
    runStarted() {
      const othersAtStart = inFlight.size - 1;
      const enteredAtStart = entered;
      return () => othersAtStart <= 0 && entered === enteredAtStart;
    },
    get active() { return inFlight.size; },
  };
}

/**
 * Under a fan-out, should a fault stop before its last probe run and take that
 * run alone later? Yes when every run so far was a kill, none was alone, and
 * another fault is in flight right now: those runs are a kill only if no
 * neighbour caused them, and a run alone is the one that can say so. With
 * nothing else in flight the last run is taken here and now (it is alone
 * unless a fault starts during it, which `mustConfirmAlone` catches). At N = 1
 * the only run is the last.
 */
export function deferLastRun(runsSoFar, confirmRuns, othersInFlight) {
  if (!othersInFlight || runsSoFar.length !== confirmRuns - 1) return false;
  return runsSoFar.every((run) => isKillRun(run) && !run.alone);
}

/**
 * All N runs are kills and not one was alone: the kill may not be reported
 * from them. The last run is set aside and taken again alone.
 */
export function mustConfirmAlone(runs, confirmRuns) {
  return runs.length === confirmRuns && runs.every((run) => isKillRun(run) && !run.alone);
}

/**
 * A run alone came out green while a run beside other faults did not: the red
 * was the neighbours'. That is evidence about the defender set (it shares
 * something with the other trees), never flakiness of the fault.
 */
export function aloneDisagrees(runs) {
  return runs.some((run) => run.alone && run.outcome === 'pass') && runs.some((run) => !run.alone && run.outcome !== 'pass');
}

/**
 * Verdicts a contended machine can manufacture. Per-run budgets do not scale
 * with the fan-out, so a defender that needs its whole budget alone can time
 * out beside n-1 other suites, and an assertion that races a clock can
 * disagree with itself. Neither is a statement about the claim, so neither is
 * reported from a concurrent measurement: it is measured again with nothing
 * else running. `defenders-not-green` is NOT here — baselines are measured
 * before the fan-out, one at a time, so they were never contended.
 */
export function needsSerialRemeasure(record) {
  if (!record || record.reusedFrom) return false;
  if (record.verdict === 'timeout') return true;
  const reason = record.detail?.reason;
  // The wider suite's run is the one most exposed to neighbours, and its N/N
  // failures name other files as killers; a load that failed can be a port or
  // a lock taken by a neighbour, not the replacement (#270).
  if (reason === 'killed-by-undeclared-tests') return true;
  // A suite that would not load, or a measurement that could not finish, is
  // never final beside other faults: a neighbour can hold the port or the
  // file it needed (#287). Only the type check's refusal is about the text
  // alone, and it ran while planning, before any fan-out.
  if (record.verdict === 'fault-invalid' && reason !== 'replacement-does-not-typecheck') return true;
  if (record.verdict === 'unverifiable') return true;
  if ((record.detail?.probeRuns ?? []).some((run) => run.outcome === 'error')) return true;
  return record.verdict === 'flaky-defender' && reason === 'inconsistent-probe';
}

/**
 * Publish results in index order whatever order they finish in. `settle(i, v)`
 * stores a result; every result whose predecessors are all settled is passed
 * to `emit` immediately, in order. An index that is never settled — a record
 * waiting for its serial re-measure — holds back everything after it. The
 * order a consumer sees is therefore the claim/fault order of a serial run,
 * deterministically.
 */
export function orderedEmitter(count, emit) {
  const values = new Array(count);
  const settled = new Array(count).fill(false);
  let cursor = 0;
  return {
    settle(i, value) {
      if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError(`index ${i} outside 0..${count - 1}`);
      if (i < cursor) throw new Error(`index ${i} was already emitted`);
      values[i] = value;
      settled[i] = true;
      while (cursor < count && settled[cursor]) emit(values[cursor], cursor++);
    },
    get emitted() { return cursor; },
  };
}

/**
 * Run `work(item, slot)` over `items` with at most `slots.length` in flight,
 * one item per slot at a time: a slot is a scratch tree, and no two faults may
 * ever share one. Items are dispatched in index order.
 *
 * On a failure no new item is dispatched; every item already running is
 * allowed to finish (so nothing is still mutating a tree when cleanup removes
 * it), and then the failure with the LOWEST item index is thrown — the one a
 * serial run would have hit first, so the error does not depend on timing.
 * `beforeEach()` runs before each dispatch (the command budget's check); a
 * throw there is a failure at that index.
 */
export async function runPool(items, slots, work, { beforeEach = () => {} } = {}) {
  if (!slots.length) throw new Error('runPool needs at least one slot');
  let next = 0;
  const failures = [];
  const lane = async (slot) => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try {
        beforeEach(index);
        await work(items[index], slot, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(slots.map((slot) => lane(slot)));
  if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0].error;
}

/**
 * Wall-clock time during which at least one runner was executing. Serially
 * this is exactly the sum of the invocations; under a fan-out a sum would
 * exceed the elapsed time and make `overheadMs` negative, so overlapping
 * invocations are charged once (the union of their intervals).
 */
export function createBusyClock(now) {
  let active = 0;
  let since = 0;
  let total = 0;
  return {
    start() {
      if (active++ === 0) since = now();
    },
    stop() {
      if (active === 0) throw new Error('busy clock stopped more often than started');
      if (--active === 0) total += now() - since;
    },
    get totalMs() { return active > 0 ? total + (now() - since) : total; },
    get active() { return active; },
  };
}

/**
 * Single-flight memo: concurrent askers of the same key share one promise, so
 * a question (the negative control of a target and defender set) is paid once
 * whichever tree asks first, exactly as a serial run pays it once.
 */
export function singleFlight(cache, key, compute) {
  if (!cache.has(key)) {
    const pending = Promise.resolve().then(compute);
    cache.set(key, pending);
    pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
  }
  return cache.get(key);
}
