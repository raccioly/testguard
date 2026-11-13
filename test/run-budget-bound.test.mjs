// A run ends in bounded time after its budget (#310): the budget fires, the
// run is recorded `timeout` with the time to that moment, and the teardown has
// a fixed grace. Each fixture is a real process tree; every process a test
// starts is recorded by pid and killed by pid afterwards, never by name.
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProcess, terminateProcessTree, terminateAtBudget, processRows, BUDGET_GRACE_MS } from '../src/probe/runners/shared.mjs';
import { annotateTimeout, timeoutContentionNote, teardownWarning } from '../src/probe/contention.mjs';
import { CommandBudget, BudgetExhaustedError } from '../src/command-budget.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const BUDGET = 1000;
const GRACE = 400;
const SLACK = 1200; // a loaded CI machine runs late; the bound under test is budget + grace + this
const LIFE = BUDGET + GRACE + 2000; // an orphan outlives the budget plus the grace by 2 s, then ends by itself
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'testguard.mjs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;

let dirs = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tg-bound-')); dirs.push(dir); return dir; };
const pidsOf = (dir) => (existsSync(join(dir, 'pids')) ? readFileSync(join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) : []);

/** Alive means running: a zombie awaiting its reaper is dead. */
function alive(pid) {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '' && !r.stdout.trim().startsWith('Z');
}
async function allDead(pids, within = 1500) {
  const until = Date.now() + within;
  while (pids.some(alive) && Date.now() < until) await sleep(50);
  return !pids.some(alive);
}

afterEach(() => {
  for (const dir of dirs) {
    for (const pid of pidsOf(dir)) { try { process.kill(pid, 'SIGKILL'); } catch {} } // only pids this test's fixtures recorded
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

/** JS that records its own pid, for the fixture to kill by pid afterwards. */
const record = (dir) => `require('fs').appendFileSync(${q(join(dir, 'pids'))}, process.pid + '\\n');`;
const hold = 'setInterval(() => {}, 1000);';
const lives = (ms) => `setTimeout(() => process.exit(), ${ms});`;
const spawnJs = (code, options) => `require('child_process').spawn(process.execPath, ['-e', ${q(code)}], ${options})`;

const FIXTURES = {
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
async function timed(code, { budgetMs = BUDGET, processList = () => processRows } = {}) {
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
const bounded = ({ result, wallMs }, budgetMs = BUDGET) => {
  expect(result.run.outcome).toBe('timeout');
  expect(result.timeouts).toBe(1);
  expect(result.run.durationMs).toBeLessThanOrEqual(budgetMs + GRACE);
  expect(wallMs).toBeLessThanOrEqual(budgetMs + GRACE + SLACK);
};

describe('a run ends within its budget plus the grace', () => {
  it('a child that ignores SIGTERM is killed (SIGKILL, not SIGTERM) and the teardown is confirmed', async () => {
    const run = await timed(FIXTURES.ignoresSigterm);
    bounded(run);
    expect(run.pids.length).toBeGreaterThan(0);
    expect(await allDead(run.pids)).toBe(true);
    expect(run.result.teardown).toBeUndefined();
    expect(run.result.loadMessage).toMatch(/every process of its tree was confirmed dead/);
  });

  it('a same-group grandchild holding the pipe after the child exits does not hold the run', async () => {
    const run = await timed(FIXTURES.groupGrandchildHoldsPipe);
    bounded(run);
    expect(await allDead(run.pids)).toBe(true);
  });

  it('a detached grandchild nobody can find holds the pipe: the run still ends, and says it could not confirm', async () => {
    const run = await timed(FIXTURES.orphanHoldsPipe);
    bounded(run);
    expect(run.pids.length).toBeGreaterThan(0);
    expect(run.result.teardown).toMatchObject({ unconfirmed: true, pipeHeld: true });
    expect(run.result.loadMessage).toMatch(/teardown NOT confirmed.*output pipe was still held by a process TestGuard could not find/);
    expect(run.result.loadMessage).not.toMatch(/every process of its tree was confirmed dead/);
    // `durationMs` is the run, not the run plus its teardown: the pipe wait is teardown.
    expect(run.wallMs - run.result.run.durationMs).toBeGreaterThanOrEqual(GRACE - 100);
  });

  it('a webServer-style server of its own process group is found by its parent and killed', async () => {
    const run = await timed(FIXTURES.webServer);
    bounded(run);
    expect(run.pids.length).toBe(2);
    expect(await allDead(run.pids)).toBe(true);
    expect(run.result.teardown).toBeUndefined();
  });

  it('a process table that fails to read twice is retried while the tree is frozen, and the server is still found', async () => {
    let calls = 0;
    const run = await timed(FIXTURES.webServer, { processList: () => (options) => (++calls <= 2 ? null : processRows(options)) });
    bounded(run);
    expect(calls).toBeGreaterThan(2);
    expect(await allDead(run.pids)).toBe(true);
  });

  it('a process table that never reads is an unverified teardown, said so, never success', async () => {
    const run = await timed(FIXTURES.webServer, { processList: () => () => null });
    bounded(run);
    expect(run.result.teardown).toMatchObject({ unconfirmed: true, unlisted: true });
    expect(run.result.loadMessage).toMatch(/teardown NOT confirmed: .*process table could not be read/);
  });

  it('a process that cannot be confirmed dead is reported with its count and the run still ends at the grace', async () => {
    // The table keeps listing one process of the run's group that no signal will ever remove.
    const ghost = 2_147_483_646;
    const processList = (dir) => () => {
      const pids = pidsOf(dir);
      return pids.length === 0 ? [] : [{ pid: ghost, ppid: pids[0], pgid: pids[0], stat: 'S' }];
    };
    const outcome = await timed(FIXTURES.ignoresSigterm, { processList });
    bounded(outcome);
    expect(outcome.result.teardown).toMatchObject({ unconfirmed: true, alive: 1 });
    expect(outcome.result.loadMessage).toMatch(/1 process of the run's tree still alive/);
  });

  it('a run capped by the command budget obeys the same bound, and the command budget still reads it as cut', async () => {
    const budget = new CommandBudget(1200);
    const granted = budget.runBudget(120_000);
    expect(granted).toBeLessThanOrEqual(1200);
    const run = await timed(FIXTURES.orphanHoldsPipe, { budgetMs: granted });
    bounded(run, granted);
    expect(() => budget.assertNotCut(granted, 120_000, run.result.timeouts)).toThrow(BudgetExhaustedError);
  });
});

describe('terminateProcessTree', () => {
  it('kills the group and its detached descendant before it returns, and says what it signaled', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.webServer(dir)], { detached: true, stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (pidsOf(dir).length < 2 && Date.now() < until) await sleep(25);
    expect(pidsOf(dir).length).toBe(2);
    const signaled = terminateProcessTree(child);
    expect(signaled.listed).toBe(true);
    expect(signaled.pids.length).toBeGreaterThanOrEqual(1);
    expect(await allDead(pidsOf(dir))).toBe(true);
  });

  it('says the table could not be read rather than treating it as an empty tree', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.ignoresSigterm(dir)], { detached: true, stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (pidsOf(dir).length < 1 && Date.now() < until) await sleep(25);
    const signaled = terminateProcessTree(child, { list: () => null, listMs: 100 });
    expect(signaled.listed).toBe(false);
    expect(await allDead(pidsOf(dir))).toBe(true);
  });
});

describe('terminateAtBudget', () => {
  it('lets a caller that waits on `close` move on when a survivor holds the pipe', async () => {
    const dir = fresh();
    const child = spawn(process.execPath, ['-e', FIXTURES.orphanHoldsPipe(dir)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise((done) => child.once('close', done));
    await sleep(300);
    const started = Date.now();
    terminateAtBudget(child, 300);
    await closed;
    expect(Date.now() - started).toBeLessThanOrEqual(300 + SLACK);
  });
});

describe('what a timed-out run says beyond its verdict', () => {
  const runner = (pid) => ({ pid, command: 'node vitest' });
  it('a count of busy runners makes the timeout an environment condition, never names', () => {
    expect(timeoutContentionNote({ detected: false, runners: [] })).toBe('');
    expect(timeoutContentionNote(undefined)).toBe('');
    const one = timeoutContentionNote({ detected: true, runners: [runner(11)] });
    expect(one).toMatch(/^1 other test runner was busy .*environment condition/);
    expect(one).not.toContain('11');
    expect(timeoutContentionNote({ detected: true, runners: [runner(1), runner(2)] })).toMatch(/^2 other test runners were busy/);
  });

  it('annotateTimeout adds the note to the message, warns once for an unconfirmed teardown, and keeps the verdict', () => {
    const warnings = [];
    const result = { run: { outcome: 'timeout' }, timeouts: 1, loadMessage: 'budget of 1000ms exceeded', teardown: { unconfirmed: true, alive: 2, unlisted: false, pipeHeld: true } };
    annotateTimeout(result, { contention: { detected: true, runners: [runner(7)] }, onWarn: (line) => warnings.push(line), graceMs: 5000 });
    expect(result.run.outcome).toBe('timeout');
    expect(result.loadMessage).toMatch(/^budget of 1000ms exceeded; 1 other test runner was busy/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(teardownWarning(result.teardown, 5000));
    expect(warnings[0]).toMatch(/2 processes still alive; its output pipe is held by a process TestGuard could not find/);
    const quiet = [];
    annotateTimeout({ run: { outcome: 'timeout' }, loadMessage: 'x' }, { contention: { detected: false, runners: [] }, onWarn: (line) => quiet.push(line), graceMs: 5000 });
    expect(quiet).toEqual([]);
  });

  it('the grace is five seconds', () => {
    expect(BUDGET_GRACE_MS).toBe(5000);
  });
});

describe('probe: the timeout record', () => {
  it('says the run ended at the budget and that other runners were busy, and stays a timeout', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bound', private: true, type: 'module' }));
    writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
    writeFileSync(join(dir, 'src/hang.mjs'), 'export const hang = () => 1;\n');
    writeFileSync(join(dir, 'test/hang.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { hang } from '../src/hang.mjs';\ntest('hang', () => { assert.equal(hang(), 1); });\n");
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({
      schemaVersion: 1,
      claims: [{ id: 'HANG', statement: 'hang holds.', source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: ['test/hang.test.mjs'],
        faults: [{ id: 'F1', description: 'the subject never returns', faultClass: 'return-altered', file: 'src/hang.mjs', find: '=> 1', replace: '=> { for (;;) {} }', producedBy: { producer: 'human' } }] }],
    }));
    const git = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    // Another test runner, busy on this machine: its command line names one. Killed by pid below.
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'vitest', 'decoy'], { stdio: 'ignore' });
    try {
      await sleep(150);
      const out = join(dir, 'evidence.json');
      const run = spawnSync(process.execPath, [CLI, 'probe', dir, '--runner', 'node-test', '--confirm', '1', '--budget', '2000', '--no-escalate', '--quiet', '--out', out], { encoding: 'utf8', timeout: 60_000 });
      expect(existsSync(out), run.stderr).toBe(true);
      const record = JSON.parse(readFileSync(out, 'utf8')).records[0];
      expect(record.verdict).toBe('timeout');
      expect(record.detail.reason).toBe('test-timed-out');
      expect(record.detail.message).toMatch(/^budget of 2000ms exceeded; the run ended there and its teardown was given 5000ms; every process of its tree was confirmed dead/);
      expect(record.detail.message).toMatch(/other test runners? (was|were) busy on this machine when the run timed out.*environment condition/);
      expect(record.detail.probeRuns.every((r) => r.durationMs <= 2000 + BUDGET_GRACE_MS)).toBe(true);
    } finally {
      try { decoy.kill('SIGKILL'); } catch {}
    }
  }, 90_000);
});
