// Shared fixtures for the run-budget tests (#310): real process trees, small budgets, every process
// a test starts recorded by pid and killed by pid afterwards, never by name.
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { runProcess, processRows } from '../../src/probe/runners/shared.mjs';

export const BUDGET = 500;
export const GRACE = 250;
export const SLACK = 1200; // a loaded CI machine runs late; the bound under test is budget + grace + this
export const LIFE = BUDGET + GRACE + 1500; // an orphan outlives the budget plus the grace by 1.5 s, then ends by itself
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const q = JSON.stringify;

let dirs = [];

export const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tg-bound-')); dirs.push(dir); return dir; };
export const pidsOf = (dir) => (existsSync(join(dir, 'pids')) ? readFileSync(join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) : []);

/** Alive means running: a zombie awaiting its reaper is dead. */
export function alive(pid) {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '' && !r.stdout.trim().startsWith('Z');
}
export async function allDead(pids, within = 1500) {
  const until = Date.now() + within;
  while (pids.some(alive) && Date.now() < until) await sleep(50);
  return !pids.some(alive);
}

export function cleanup() {
  for (const dir of dirs) {
    for (const pid of pidsOf(dir)) { try { process.kill(pid, 'SIGKILL'); } catch {} } // only pids this test's fixtures recorded
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
}

/** JS that records its own pid, for the fixture to kill by pid afterwards. */
export const record = (dir) => `require('fs').appendFileSync(${q(join(dir, 'pids'))}, process.pid + '\\n');`;
export const hold = 'setInterval(() => {}, 1000);';
export const lives = (ms) => `setTimeout(() => process.exit(), ${ms});`;
export const spawnJs = (code, options) => `require('child_process').spawn(process.execPath, ['-e', ${q(code)}], ${options})`;

export const FIXTURES = {
  // A child that ignores SIGTERM.
  ignoresSigterm: (dir) => `${record(dir)} process.on('SIGTERM', () => {}); ${hold} ${lives(LIFE)}`,
  // The direct child exits at once; a grandchild of the same process group keeps the stdout/stderr pipe open.
  groupGrandchildHoldsPipe: (dir) => `${spawnJs(`${record(dir)} ${hold} ${lives(LIFE)}`, "{ stdio: 'inherit' }")}; process.exit(0);`,
  // The pipe is held by a detached grandchild whose parent is already gone: nobody can find it by pid.
  orphanHoldsPipe: (dir) => `${spawnJs(`${record(dir)} ${hold} ${lives(LIFE)}`, "{ stdio: 'inherit', detached: true }")}; process.exit(0);`,
  // A runner that starts a long-lived server of its own process group (a webServer) and keeps running.
  webServer: (dir) => `${record(dir)} ${spawnJs(`${record(dir)} process.on('SIGTERM', () => {}); ${hold} ${lives(LIFE)}`, "{ stdio: 'ignore', detached: true }")}; ${hold} ${lives(LIFE)}`,
};

/**
 * Run a fixture under the budget and time it from outside. `processList` builds a stand-in for `ps`.
 * A watchdog turns a run that never ends into a failed assertion (a hang is a timeout, never a kill)
 * and then releases the sweep so a build that cannot end does not keep looping after the test.
 */
export async function timed(code, { budgetMs = BUDGET, processList = () => processRows } = {}) {
  const dir = fresh();
  const started = Date.now();
  let released = false;
  const base = processList(dir);
  const list = (options) => (released ? [] : base(options));
  const hung = Symbol('hung');
  const outcome = await Promise.race([
    runProcess({ argv: () => [], projectDir: dir, files: [], budgetMs, graceMs: GRACE, command: [process.execPath, '-e', code(dir)], processList: list }),
    sleep(budgetMs + GRACE + SLACK + 1000).then(() => hung),
  ]);
  released = true;
  expect(outcome, 'the run did not end within its budget plus the grace').not.toBe(hung);
  return { result: outcome, wallMs: Date.now() - started, dir, pids: pidsOf(dir) };
}
export const bounded = ({ result, wallMs }, budgetMs = BUDGET) => {
  expect(result.run.outcome).toBe('timeout');
  expect(result.timeouts).toBe(1);
  expect(result.run.durationMs).toBeLessThanOrEqual(budgetMs + GRACE + 500);
  expect(wallMs).toBeLessThanOrEqual(budgetMs + GRACE + SLACK);
};

