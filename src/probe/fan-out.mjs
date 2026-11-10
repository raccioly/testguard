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
  return record.verdict === 'flaky-defender' && record.detail?.reason === 'inconsistent-probe';
}

/**
 * Publish results in index order whatever order they finish in. `settle(i, v)`
 * stores a result; every result whose predecessors are all settled is passed
 * to `emit` immediately, in order. `hold(i)` marks an index as not yet final
 * (a record waiting for its serial re-measure): it and everything after it
 * wait until `settle(i, v)` is called again. The order a consumer sees is
 * therefore the claim/fault order of a serial run, deterministically.
 */
export function orderedEmitter(count, emit) {
  const values = new Array(count);
  const state = new Array(count).fill('pending'); // pending | held | settled
  let cursor = 0;
  const flush = () => {
    while (cursor < count && state[cursor] === 'settled') emit(values[cursor], cursor++);
  };
  return {
    settle(i, value) {
      if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError(`index ${i} outside 0..${count - 1}`);
      if (i < cursor) throw new Error(`index ${i} was already emitted`);
      values[i] = value;
      state[i] = 'settled';
      flush();
    },
    hold(i) {
      if (i < cursor) throw new Error(`index ${i} was already emitted`);
      state[i] = 'held';
    },
    get emitted() { return cursor; },
    values: () => values.slice(),
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
