// The karma adapter (#329) for Angular: `ng test` with a generated Karma config
// that forces the JUnit reporter into a scratch directory. Tested with a fake
// `ng` that loads that generated config the way Karma would and writes the XML
// karma-junit-reporter is documented to write. It was not run against a real
// Karma or Chrome in this tree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import * as karma from '../src/probe/runners/karma.mjs';
import { RUNNERS, RUNNER_NAMES, OWNED_RUNNERS, selectRunner, runnerUnresolvableMessage } from '../src/probe/runners/index.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';

let dir;
beforeEach(() => { resetRunnerCache(); dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-karma-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const angularJson = (builder = '@angular-devkit/build-angular:karma', extra = {}) => JSON.stringify({
  version: 1,
  projects: { app: { root: '', sourceRoot: 'src', architect: { test: { builder, options: { ...extra } } } } },
});
const spec = 'src/app/price.spec.ts';
// `auto` falls back to a runner on PATH, and vitest puts node_modules/.bin on
// the PATH of its own tests: take those entries out so "nothing resolves" holds.
const withoutLocalBin = async (fn) => {
  const saved = process.env.PATH;
  process.env.PATH = saved.split(delimiter).filter((p) => !/node_modules[\\/]\.bin/.test(p)).join(delimiter);
  try { return await fn(); } finally { process.env.PATH = saved; }
};

// A fake `ng` that does what the CLI does with `--karma-config`: it loads the
// config, lets it set what Karma would be given, and writes the JUnit report to
// the directory that config named. Behavior is data in .fake-ng.json.
const FAKE_NG = `
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
const cfg = fs.existsSync('.fake-ng.json') ? JSON.parse(fs.readFileSync('.fake-ng.json', 'utf8')) : {};
fs.writeFileSync('.fake-argv.json', JSON.stringify(argv));
if (argv[0] === '--version') { console.log('Angular CLI: 19.0.0'); process.exit(0); }
if (cfg.mode === 'hang') { fs.writeFileSync('.fake-pid', String(process.pid)); const t = Date.now(); while (Date.now() - t < 60000) {} }
if (cfg.mode === 'compile-error') { console.log('Error: src/app/price.ts:5:3 - error TS1005: ; expected.'); process.exit(1); }
const flag = argv.find((a) => a.startsWith('--karma-config='));
const set = {};
const config = { plugins: ['base-plugin'], set(o) { Object.assign(config, o); } };
require(flag.slice('--karma-config='.length))(config);
fs.writeFileSync('.fake-config.json', JSON.stringify({ reporters: config.reporters, junitReporter: config.junitReporter, singleRun: config.singleRun, autoWatch: config.autoWatch, plugins: config.plugins.map((p) => typeof p === 'string' ? p : 'plugin-object') }));
if (cfg.mode === 'no-report') process.exit(cfg.exit || 0);
const out = path.join(config.junitReporter.outputDir, config.junitReporter.outputFile);
fs.mkdirSync(config.junitReporter.outputDir, { recursive: true });
const how = cfg.result || 'pass';
const body = how === 'pass' ? '<testcase name="Price adds" classname="Chrome_Headless.Price"/>'
  : '<testcase name="Price adds" classname="Chrome_Headless.Price"><failure type="">Expected 3 to be 4.</failure></testcase>';
fs.writeFileSync(out, '<?xml version="1.0"?><testsuites><testsuite name="Chrome Headless 120" tests="1" errors="0" failures="' + (how === 'pass' ? 0 : 1) + '">' + body + '</testsuite></testsuites>');
process.exit(how === 'pass' ? (cfg.mode === 'exit1-green' ? 1 : 0) : 1);
`;
const project = (behavior = {}, { conf = true } = {}) => {
  put('angular.json', angularJson());
  put(spec, 'describe("price", () => {});\n');
  if (conf) put('karma.conf.js', 'module.exports = function (config) { config.set({ frameworks: ["jasmine"] }); };\n');
  put('node_modules/@angular/cli/package.json', JSON.stringify({ name: '@angular/cli', version: '19.0.0', bin: { ng: 'bin/ng.js' } }));
  put('node_modules/@angular/cli/bin/ng.js', FAKE_NG);
  put('node_modules/karma-junit-reporter/package.json', JSON.stringify({ name: 'karma-junit-reporter', version: '2.0.1', main: 'index.js' }));
  put('node_modules/karma-junit-reporter/index.js', "module.exports = { 'reporter:junit': ['type', function () {}] };\n");
  put('.fake-ng.json', JSON.stringify(behavior));
};
const run = (files = [spec], extra = {}) => karma.run({ projectDir: dir, sourceDir: dir, files, budgetMs: 20_000, ...extra });

describe('registration', () => {
  it('is selectable by name and never owned or chosen by auto', () => {
    expect(RUNNERS.karma).toBe(karma);
    expect(RUNNER_NAMES).toContain('karma');
    expect(OWNED_RUNNERS.map((r) => r.name)).not.toContain('karma');
    expect(karma.owns).toBeUndefined();
  });
});

describe('auto never picks it, and says what it found instead of "npm i -D vitest"', () => {
  it('names Karma, the flag that runs it, and the other runners\' reasons', async () => {
    put('angular.json', angularJson());
    put('package.json', JSON.stringify({ devDependencies: { karma: '^6.4.0', '@angular/cli': '^19' } }));
    put(spec);
    const sel = await withoutLocalBin(() => selectRunner({ projectDir: dir, sourceDir: dir, name: 'auto' }));
    expect(sel.error).toMatch(/^Karma was found/);
    expect(sel.error).toContain('--runner karma');
    expect(sel.error).toContain('karma-junit-reporter');
    expect(sel.error).toContain('vitest');
    expect(sel.detected).toEqual([expect.objectContaining({ runner: 'karma' })]);
    const message = runnerUnresolvableMessage({ sel, mode: 'in-place' });
    expect(message).toMatch(/^test runner is not resolvable in the project \(Karma was found/);
    expect(message).not.toMatch(/If dependencies are missing, install them first/);
    expect(message).toContain('--runner karma');
  });

  it('a project with no build system keeps the old message', async () => {
    put('package.json', '{}');
    const sel = await withoutLocalBin(() => selectRunner({ projectDir: dir, sourceDir: dir, name: 'auto' }));
    expect(sel.detected).toBeUndefined();
    expect(runnerUnresolvableMessage({ sel, mode: 'in-place' })).toContain('If dependencies are missing, install them first');
  });

  it('a Maven project is told to use --runner maven', async () => {
    put('pom.xml', '<project/>');
    const sel = await selectRunner({ projectDir: dir, sourceDir: dir, name: 'auto' });
    expect(sel.error).toMatch(/Maven was found.*--runner maven/);
  });
});

describe('check', () => {
  it('needs angular.json, the Angular CLI, karma-junit-reporter and a Karma config, and says which is missing', async () => {
    expect((await karma.check({ projectDir: dir })).message).toContain('angular.json');
    put('angular.json', angularJson());
    expect((await karma.check({ projectDir: dir })).message).toMatch(/@angular\/cli/);
    resetRunnerCache();
    project();
    rmSync(join(dir, 'node_modules/karma-junit-reporter'), { recursive: true });
    expect((await karma.check({ projectDir: dir })).message).toContain('npm i -D karma-junit-reporter');
    project({}, { conf: false });
    rmSync(join(dir, 'karma.conf.js'), { force: true });
    expect((await karma.check({ projectDir: dir })).message).toContain('ng generate config karma');
  });

  it('reports the Angular CLI version as a project runner', async () => {
    project();
    expect(await karma.check({ projectDir: dir })).toEqual({ ok: true, version: '19.0.0', source: 'project' });
  });

  it('is selectable by name with the spec files as its universe', async () => {
    project();
    put('src/app/other.spec.ts');
    put('src/app/not-a-test.ts');
    const sel = await selectRunner({ projectDir: dir, sourceDir: dir, name: 'karma' });
    expect(sel).toMatchObject({ version: '19.0.0', testFiles: 2 });
    expect(sel.manifest.files).toEqual(['src/app/other.spec.ts', spec]);
    expect(sel.manifest.configFiles.map((c) => c.path)).toEqual(expect.arrayContaining(['angular.json', 'karma.conf.js']));
  });
});

describe('run', () => {
  it('a green spec passes, run headless under the generated config and an include per file', async () => {
    project();
    const r = await run();
    expect(r.run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
    const argv = JSON.parse(readFileSync(join(dir, '.fake-argv.json'), 'utf8'));
    expect(argv).toEqual(expect.arrayContaining(['test', 'app', '--watch=false', '--browsers=ChromeHeadless', `--include=${spec}`]));
    const loaded = JSON.parse(readFileSync(join(dir, '.fake-config.json'), 'utf8'));
    expect(loaded).toMatchObject({ reporters: ['junit'], singleRun: true, autoWatch: false });
    expect(loaded.plugins).toEqual(['base-plugin', 'plugin-object']);
    expect(loaded.junitReporter.outputDir).not.toContain(dir);
  });

  it('a failure is a kill that counts as an exception: Jasmine reports no assertion type', async () => {
    project({ result: 'fail' });
    const r = await run();
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 0, exceptionFailures: 1 });
  });

  it('removes what it wrote: the generated config and the report directory', async () => {
    project();
    const before = new Set(readdirSync(tmpdir()));
    await run();
    const leftover = readdirSync(tmpdir()).filter((n) => !before.has(n) && /testguard-karma/.test(n));
    expect(leftover).toEqual([]);
  });

  it('CONTRACT: no report is an error, never a pass', async () => {
    project({ mode: 'no-report' });
    expect((await run()).run.outcome).toBe('error');
  });

  it('a compile error is an error that says what the CLI said', async () => {
    project({ mode: 'compile-error' });
    const r = await run();
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toContain('error TS1005');
  });

  it('a green report beside a failed run is an error', async () => {
    project({ mode: 'exit1-green' });
    expect((await run()).run.outcome).toBe('error');
  });

  it('a file in no karma project is an error, and nothing starts', async () => {
    project();
    put('angular.json', JSON.stringify({ projects: { web: { root: 'apps/web', architect: { test: { builder: '@angular/build:karma' } } } } }));
    put('elsewhere/x.spec.ts');
    const r = await run(['elsewhere/x.spec.ts']);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/no Angular project with a karma test target/);
    expect(existsSync(join(dir, '.fake-argv.json'))).toBe(false);
  });

  it('CONTRACT: a hang ends at the budget, with its process gone', async () => {
    project({ mode: 'hang' });
    const started = Date.now();
    const r = await run([spec], { budgetMs: 600, graceMs: 2000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.run.outcome).toBe('timeout');
    const pid = Number(readFileSync(join(dir, '.fake-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
