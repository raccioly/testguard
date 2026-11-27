// The gradle adapter (#329) against a fake `gradlew` that writes the files
// Gradle is documented to write under build/test-results/test. Not run against
// a real Gradle in this tree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gradle from '../src/probe/runners/gradle.mjs';
import { RUNNERS, RUNNER_NAMES, OWNED_RUNNERS, selectRunner } from '../src/probe/runners/index.mjs';
import { writeFakeTool, fakeArgv } from './helpers/fake-jvm.mjs';

let dir;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-gradle-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const test1 = 'src/test/java/demo/DiscountTest.java';
const project = (behavior = {}) => {
  put('build.gradle.kts', '');
  put(test1);
  writeFakeTool(dir, 'gradlew', { kind: 'gradle', ...behavior });
};
const run = (files, extra = {}) => gradle.run({ projectDir: dir, sourceDir: dir, files, budgetMs: 20_000, ...extra });

describe('registration', () => {
  it('is selectable by name and never owned or chosen by auto', () => {
    expect(RUNNERS.gradle).toBe(gradle);
    expect(RUNNER_NAMES).toContain('gradle');
    expect(OWNED_RUNNERS.map((r) => r.name)).not.toContain('gradle');
  });
});

describe('check', () => {
  it('runs the project wrapper', async () => {
    project();
    expect(await gradle.check({ projectDir: dir })).toEqual({ ok: true, version: '8.5', source: 'project' });
  });

  it.each(['build.gradle', 'settings.gradle', 'settings.gradle.kts'])('a %s is enough of a build file', async (marker) => {
    put(marker);
    writeFakeTool(dir, 'gradlew', { kind: 'gradle' });
    expect((await gradle.check({ projectDir: dir })).ok).toBe(true);
  });

  it('refuses a project with no Gradle build file, and a tool that does not answer', async () => {
    writeFakeTool(dir, 'gradlew', { kind: 'gradle' });
    expect((await gradle.check({ projectDir: dir })).message).toContain('build.gradle');
    put('build.gradle');
    writeFakeTool(dir, 'gradlew', { kind: 'gradle', versionFails: true });
    expect((await gradle.check({ projectDir: dir })).message).toContain('./gradlew');
  });

  it('says install Gradle when neither a wrapper nor the tool exists', async () => {
    put('build.gradle');
    const empty = join(dir, 'empty'); mkdirSync(empty);
    const r = await gradle.check({ projectDir: dir, env: { PATH: empty } });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/install Gradle or add a wrapper/);
  });
});

describe('the test universe', () => {
  it('is the JUnit files, bound to the build files of the project', async () => {
    project();
    put('src/test/kotlin/demo/PriceTest.kt');
    put('settings.gradle.kts', 'a');
    expect(gradle.tests(dir)).toEqual([test1, 'src/test/kotlin/demo/PriceTest.kt']);
    const first = await gradle.discoverTests({ projectDir: dir, version: '8.5' });
    put('settings.gradle.kts', 'b');
    expect((await gradle.discoverTests({ projectDir: dir, version: '8.5' })).testUniverseHash).not.toBe(first.testUniverseHash);
    expect(first.configFiles.map((c) => c.path)).toEqual(expect.arrayContaining(['build.gradle.kts', 'settings.gradle.kts']));
  });

  it('is selectable by name', async () => {
    project();
    expect(await selectRunner({ projectDir: dir, sourceDir: dir, name: 'gradle' })).toMatchObject({ version: '8.5', source: 'project', testFiles: 1 });
  });

  it('owns a test only where a Gradle build file is above it', () => {
    put('build.gradle');
    expect(gradle.owns(dir, test1)).toBe(true);
    expect(gradle.owns(dir, 'src/test/java/demo/Helper.java')).toBe(false);
    rmSync(join(dir, 'build.gradle'));
    expect(gradle.owns(dir, test1)).toBe(false);
  });
});

describe('run', () => {
  it('reads build/test-results/test, and starts the tool with the flags that keep it honest', async () => {
    project({ classes: { 'demo.DiscountTest': 'assert' } });
    const r = await run([test1]);
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 1 });
    const [argv] = fakeArgv(dir);
    expect(argv).toEqual(expect.arrayContaining(['--no-daemon', '--no-build-cache', ':cleanTest', ':test', '--tests', 'demo.DiscountTest']));
  });

  it('a green run passes', async () => {
    project({ classes: { 'demo.DiscountTest': 'pass' } });
    expect((await run([test1])).run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
  });

  it('CONTRACT: a missing report is an error, never a pass, and a stale one is not read', async () => {
    project({ mode: 'no-report' });
    put('build/test-results/test/TEST-demo.DiscountTest.xml', '<testsuite name="demo.DiscountTest" tests="1"><testcase name="t" classname="demo.DiscountTest"/></testsuite>');
    const r = await run([test1]);
    expect(r.run.outcome).toBe('error');
  });

  it('reads the report of a module below the project', async () => {
    put('build.gradle'); put('billing/build.gradle'); put('billing/src/test/java/demo/InvoiceTest.java');
    writeFakeTool(dir, 'gradlew', { kind: 'gradle', classes: { 'demo.InvoiceTest': 'pass' } });
    const r = await run(['billing/src/test/java/demo/InvoiceTest.java']);
    expect(r.run.outcome).toBe('pass');
    expect(fakeArgv(dir)[0]).toEqual(expect.arrayContaining([':billing:cleanTest', ':billing:test']));
  });

  it('CONTRACT: a hang ends at the budget, with its process gone', async () => {
    project({ mode: 'hang' });
    const started = Date.now();
    const r = await run([test1], { budgetMs: 600, graceMs: 2000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.run.outcome).toBe('timeout');
    const pid = Number(readFileSync(join(dir, '.fake-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
