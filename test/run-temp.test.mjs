// The suite's own temp directory (#311): one `tg-run-<pid>-<random>` per run,
// every tmpdir() and every child process inside it, all of it gone when the
// run ends, and a crashed run's removed by the next. A small vitest project
// runs through the same setup and the leftovers are counted.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('a run through the same setup leaves nothing behind', () => {
  it('removes its directory, every tg-* entry the tests made in it, and the child\'s, and sweeps only provably dead runs', () => {
    const outer = dir();
    const project = dir('tg-run-temp-project-');
    symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'), 'dir');
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(join(project, 'vitest.config.mjs'), `export default { test: { include: ['*.test.mjs'], globalSetup: [${JSON.stringify(join(ROOT, 'test', 'helpers', 'run-temp.mjs'))}] } };\n`);
    writeFileSync(join(project, 'a.test.mjs'), `import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
it('creates temp directories and never removes them', () => {
  for (const name of ['tg-leak-', 'tg-leak-other-']) writeFileSync(join(mkdtempSync(join(tmpdir(), name)), 'big'), 'x'.repeat(1000));
  const child = spawnSync(process.execPath, ['-e', 'require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "tg-child-"))']);
  expect(child.status).toBe(0);
  writeFileSync(process.env.SEEN_FILE, tmpdir());
  expect(1).toBe(1);
});
`);
    // What is already in the real temp directory: a crashed run (dead pid here), a live run, another host's run, an ordinary directory, a run with no owner file.
    const crashed = owned(outer, 'tg-run-1-AAAAAA', { pid: DEAD, host: hostname() });
    owned(outer, 'tg-run-2-BBBBBB', { pid: process.pid, host: hostname() });
    owned(outer, 'tg-run-3-CCCCCC', { pid: DEAD, host: 'another-host' });
    owned(outer, 'tg-run-4-DDDDDD');
    owned(outer, 'tg-ordinary');
    const seen = join(project, 'seen.txt');
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--root', project], {
      encoding: 'utf8', timeout: 120_000, cwd: project,
      env: { ...process.env, TMPDIR: outer, TMP: outer, TEMP: outer, SEEN_FILE: seen, TESTGUARD_TEST_RUN_DIR: '', TESTGUARD_REAL_TMPDIR: '' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // It ran inside a per-run directory under `outer`…
    const during = readFileSync(seen, 'utf8');
    expect(dirname(during)).toBe(realpathSync(outer));
    expect(during.slice(dirname(during).length + 1)).toMatch(/^tg-run-\d+-[A-Za-z0-9]{6}$/);
    // …which is gone, with every tg-* the test and its child made in it.
    expect(readdirSync(outer).sort()).toEqual(['tg-ordinary', 'tg-run-2-BBBBBB', 'tg-run-3-CCCCCC', 'tg-run-4-DDDDDD']);
    expect(existsSync(crashed)).toBe(false);
  }, 150_000);
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

