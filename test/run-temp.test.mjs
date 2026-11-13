// The suite's own temp directory (#311): one `tg-run-<pid>-<random>` per run,
// every tmpdir() and every child process inside it, all of it gone when the
// run ends, and a crashed run's removed by the next. The end-to-end run of a
// small vitest project through the same setup is test/run-temp.run.test.mjs.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../vitest.config.mjs';
import { createRunDir, OWNER_FILE, RUN_PREFIX, setup, sweepStaleRuns } from './helpers/run-temp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const dir = (prefix = 'tg-run-temp-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

const DEAD = 2 ** 22 + 4242;
const owned = (base, name, owner) => { mkdirSync(join(base, name), { recursive: true }); if (owner) writeFileSync(join(base, name, OWNER_FILE), JSON.stringify(owner)); return join(base, name); };

describe('this repository\'s own test run', () => {
  it('runs inside the per-run directory the global setup made, so nothing it creates outlives the run', () => {
    // tmpdir() is what every test's mkdtemp starts from; it is the run's directory, not the operating system's.
    expect(tmpdir()).toBe(process.env.TESTGUARD_TEST_RUN_DIR);
    expect(process.env.TMP).toBe(tmpdir());
    expect(process.env.TEMP).toBe(tmpdir());
    expect(dirname(tmpdir())).toBe(realpathSync(process.env.TESTGUARD_REAL_TMPDIR));
    expect(tmpdir().slice(dirname(tmpdir()).length + 1)).toMatch(new RegExp(`^${RUN_PREFIX}\\d+-[A-Za-z0-9]{6}$`));
    expect(existsSync(join(tmpdir(), OWNER_FILE))).toBe(true);
  });

  it('wires the setup in the vitest configuration every run uses', () => {
    expect(config.test.globalSetup).toEqual(['./test/helpers/run-temp.mjs']);
  });

  it('a child process the tests spawn gets it too', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir())'], { encoding: 'utf8' });
    expect(r.stdout).toBe(tmpdir());
  });
});

describe('the setup and its teardown', () => {
  it('makes the run directory, points the environment at it, sweeps a crashed run, and its teardown removes everything', () => {
    const keys = ['TMPDIR', 'TMP', 'TEMP', 'TESTGUARD_TEST_RUN_DIR', 'TESTGUARD_REAL_TMPDIR'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const base = dir();
    const crashed = owned(base, 'tg-run-1-AAAAAA', { pid: DEAD, host: hostname() });
    try {
      delete process.env.TESTGUARD_TEST_RUN_DIR;
      process.env.TMPDIR = base;
      const teardown = setup();
      const run = process.env.TESTGUARD_TEST_RUN_DIR;
      expect(dirname(run)).toBe(realpathSync(base));
      expect(run.slice(dirname(run).length + 1)).toMatch(/^tg-run-\d+-[A-Za-z0-9]{6}$/);
      expect([process.env.TMPDIR, process.env.TMP, process.env.TEMP, tmpdir()]).toEqual([run, run, run, run]);
      expect(process.env.TESTGUARD_REAL_TMPDIR).toBe(base);
      expect(existsSync(join(run, OWNER_FILE))).toBe(true);
      expect(existsSync(crashed)).toBe(false);
      writeFileSync(join(mkdtempSync(join(tmpdir(), 'tg-leak-')), 'big'), 'x');
      teardown();
      expect(existsSync(run)).toBe(false);
      expect(readdirSync(base)).toEqual([]);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe('sweeping the runs of dead processes', () => {
  it('removes a run whose owner is gone on this host and nothing else', () => {
    const base = dir();
    const dead = owned(base, 'tg-run-10-aBcDeF', { pid: DEAD, host: hostname() });
    const live = owned(base, 'tg-run-11-aBcDeF', { pid: 31337, host: hostname() });
    const foreign = owned(base, 'tg-run-12-aBcDeF', { pid: DEAD, host: 'elsewhere' });
    const unowned = owned(base, 'tg-run-13-aBcDeF');
    const notMine = owned(base, 'tg-run-x-notmine', { pid: DEAD, host: hostname() });
    const similar = owned(base, 'tg-runner-sel-aBcDeF', { pid: DEAD, host: hostname() });
    expect(sweepStaleRuns(base, { alive: (pid) => pid === 31337, host: hostname() })).toEqual(['tg-run-10-aBcDeF']);
    expect([dead, live, foreign, unowned, notMine, similar].map(existsSync)).toEqual([false, true, true, true, true, true]);
  });

  it('the run directory is created under the given base, by its real path, with an owner file naming this process', () => {
    const base = dir();
    const run = createRunDir(base);
    expect(dirname(run)).toBe(base);
    expect(JSON.parse(readFileSync(join(run, OWNER_FILE), 'utf8'))).toMatchObject({ pid: process.pid, host: hostname() });
  });

  it('a setup that finds the outer run\'s directory reuses it and removes nothing, at teardown or before', () => {
    expect(existsSync(process.env.TESTGUARD_TEST_RUN_DIR)).toBe(true);
    setup()();
    expect(existsSync(process.env.TESTGUARD_TEST_RUN_DIR)).toBe(true);
  });
});

