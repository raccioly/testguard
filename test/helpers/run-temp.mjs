// One temp directory per test run (#311). The suite and the tools it spawns
// create thousands of `mkdtemp` directories; a run that crashes or is killed
// never reaches its `afterEach`. So vitest's globalSetup (vitest.config.mjs)
// creates `tg-run-<pid>-<random>` under the real OS temp directory, points
// TMPDIR/TMP/TEMP at it before any worker starts — every `os.tmpdir()` and
// every tool process the tests spawn lands inside it — and its teardown
// removes the whole directory in one `rm`. A run that died without a teardown
// is removed by the NEXT run's setup, judged by the owner file's pid and host
// (the rule the worktree lock uses), and nothing else under the temp
// directory is ever touched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAlive } from '../../src/probe/contention.mjs';
import { lockIsStale, parseLock } from '../../src/probe/worktree-lock.mjs';

export const RUN_PREFIX = 'tg-run-';
export const OWNER_FILE = 'owner.json';
const RUN_NAME = /^tg-run-(\d+)-[A-Za-z0-9]{6}$/;
/** A run directory with no readable owner file is swept only when its pid (in its name) is gone AND it is this old. */
export const OWNERLESS_AGE_MS = 60 * 60 * 1000;

/** Remove per-run directories under `base` whose owner is provably gone: the same host and a pid that no longer runs. */
/**
 * Remove a run directory, the owner file LAST: a removal that is interrupted
 * leaves a directory that still names its owner, so the next run can finish it.
 */
export function removeRunDir(dir, { rm = rmSync } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { /* gone */ }
  for (const name of names) if (name !== OWNER_FILE) rm(join(dir, name), { recursive: true, force: true });
  rmSync(join(dir, OWNER_FILE), { force: true });
  rmSync(dir, { recursive: true, force: true });
}

export function sweepStaleRuns(base, { alive = defaultAlive, host = hostname(), now = Date.now } = {}) {
  const removed = [];
  let names = [];
  try { names = readdirSync(base); } catch { return removed; }
  for (const name of names) {
    const match = RUN_NAME.exec(name);
    if (!match) continue;
    let owner = null;
    try { owner = parseLock(readFileSync(join(base, name, OWNER_FILE), 'utf8')); } catch { /* no readable owner file */ }
    if (owner) {
      if (!lockIsStale(owner, { alive, host })) continue;
    } else {
      // Killed between mkdtemp and the owner write: the pid is in the name, and a directory this old with a dead pid is not a live run.
      let old = false;
      try { old = now() - statSync(join(base, name)).mtimeMs > OWNERLESS_AGE_MS; } catch { continue; }
      if (!old || alive(Number(match?.[1]))) continue;
    }
    try { removeRunDir(join(base, name)); removed.push(name); } catch { /* another run is removing it */ }
  }
  return removed;
}

/** Create this run's directory under `base` (its real path, so /var and /private/var agree) and its owner file. */
export function createRunDir(base) {
  const dir = realpathSync(mkdtempSync(join(base, `${RUN_PREFIX}${process.pid}-`)));
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  return dir;
}

/**
 * vitest globalSetup. A run nested inside another's directory (a test that
 * runs this repository's own suite) reuses the outer one and removes nothing.
 */
export function setup() {
  const outer = process.env.TESTGUARD_TEST_RUN_DIR;
  if (outer && existsSync(outer)) return () => {};
  const real = tmpdir();
  sweepStaleRuns(real);
  const dir = createRunDir(real);
  // Tests that need the operating system's own temp directory (to prove a
  // path is NOT under the run's) read it from here.
  process.env.TESTGUARD_REAL_TMPDIR = real;
  process.env.TESTGUARD_TEST_RUN_DIR = dir;
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = dir;
  return () => { removeRunDir(dir); };
}
