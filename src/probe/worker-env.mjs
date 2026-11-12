import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { scratchRoot } from '../scratch-dir.mjs';
import { lockIsStale, parseLock } from './worktree-lock.mjs';
import { defaultAlive } from './contention.mjs';
import { UsageError } from './precondition-error.mjs';

/**
 * `TESTGUARD_WORKER` (#287): the index of the scratch tree a runner process
 * runs in, exported to every test runner the probe starts. Trees run side by
 * side under a fan-out, so a suite that needs a port, a database or a
 * directory of its own can derive it (`8787 + TESTGUARD_WORKER`) and stay
 * parallel instead of being measured alone. A run with nothing else in flight
 * (one fault at a time, a confirmation or a re-measure) is its command's
 * first index.
 *
 * Two probe commands on one machine (two agent sessions) would both hand out
 * 0 (#293). So each command adds an offset: `TESTGUARD_WORKER_BASE` when set,
 * otherwise its slot times WORKER_SLOT_STRIDE, where the slot is the lowest
 * one no live command holds (a pid-owned lock file under the scratch root,
 * beside the worktree lock). A lone command holds slot 0 and hands out 0, 1,
 * 2… as before. Commands that use different scratch roots do not coordinate.
 *
 * The values travel in an AsyncLocalStorage context, like the scratch base,
 * so two trees measuring at once never see each other's.
 */
const context = new AsyncLocalStorage();

/** How far apart two commands' indices start: more trees than any fan-out runs at once. */
export const WORKER_SLOT_STRIDE = 100;
/** Slots tried before a command gives up coordinating (and starts at 0, as before #293). */
export const WORKER_SLOTS = 64;

/** Run `fn` with `index` as the tree every runner process it starts sees (offset by its command's base). */
export const withWorker = (index, fn) => context.run({ base: context.getStore()?.base ?? 0, index }, fn);

/** The environment a runner process gets: `{ TESTGUARD_WORKER }`, base + tree index. */
export const workerEnv = () => {
  const store = context.getStore();
  return { TESTGUARD_WORKER: String((store?.base ?? 0) + (store?.index ?? 0)) };
};

/** `TESTGUARD_WORKER_BASE`, when set: a non-negative integer, or a usage error. */
export function workerBaseFromEnv(env = process.env) {
  const raw = env.TESTGUARD_WORKER_BASE;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || !Number.isSafeInteger(n)) throw new UsageError(`TESTGUARD_WORKER_BASE must be a non-negative integer, not ${JSON.stringify(raw)}`);
  return n;
}

/** Where commands record the worker slots they hold: beside the worktree lock, under the scratch root. */
export const workerSlotDir = (base = scratchRoot()) => join(base, 'testguard-locks', 'worker-slots');

/**
 * Hold the lowest free slot in `dir` until `release()`. A slot whose owner is
 * provably gone (same host, pid not running) is taken over; one written on
 * another host or unreadable is left alone. With every slot held, slot 0 is
 * returned unheld: the old behavior, never a refusal.
 */
export function claimWorkerSlot(dir, options = {}) {
  // Coordination is a courtesy: a scratch root that cannot hold a lock file
  // (read-only, full) starts at 0 unheld, as every command did before #293.
  try { return claimSlot(dir, options); } catch { return { slot: 0, held: false, release: () => {} }; }
}

function claimSlot(dir, { alive = defaultAlive, host = hostname(), slots = WORKER_SLOTS }) {
  mkdirSync(dir, { recursive: true });
  for (let slot = 0; slot < slots; slot++) {
    const path = join(dir, `slot-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd;
      try { fd = openSync(path, 'wx'); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      if (fd !== undefined) {
        try { writeSync(fd, JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() })); } finally { closeSync(fd); }
        let released = false;
        return { slot, held: true, release: () => { if (!released) { released = true; try { rmSync(path, { force: true }); } catch { /* gone or unwritable: nothing to hold */ } } } };
      }
      let owner = null;
      try { owner = parseLock(readFileSync(path, 'utf8')); } catch { owner = null; }
      if (!lockIsStale(owner, { alive, host })) break;
      rmSync(path, { force: true });
    }
  }
  return { slot: 0, held: false, release: () => {} };
}

/** Run one command's `fn` with its worker base: the environment's, else a held slot's. */
export async function withCommandWorkers(fn, { env = process.env, dir, alive } = {}) {
  const fromEnv = workerBaseFromEnv(env);
  if (fromEnv !== undefined) return context.run({ base: fromEnv, index: 0 }, fn);
  const claim = claimWorkerSlot(dir ?? workerSlotDir(), alive ? { alive } : {});
  try {
    return await context.run({ base: claim.slot * WORKER_SLOT_STRIDE, index: 0 }, fn);
  } finally {
    claim.release();
  }
}
