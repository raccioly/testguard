// The maven adapter (#329) against a fake `mvnw`/`mvn` that writes the files
// Surefire is documented to write. It was not run against a real Maven in this
// tree. The adapter contract's two run rules are proved here: a hang ends at
// the budget with its tree dead, and a missing report is an error.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as maven from '../src/probe/runners/maven.mjs';
import { RUNNERS, RUNNER_NAMES, OWNED_RUNNERS, selectRunner, discoverRunnerManifest } from '../src/probe/runners/index.mjs';
import { parseCommandTemplate } from '../src/probe/runners/shared.mjs';
import { writeFakeTool, setFakeBehavior, fakeArgv } from './helpers/fake-jvm.mjs';

let dir;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-maven-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const test1 = 'src/test/java/demo/DiscountTest.java';
const project = (behavior = {}) => {
  put('pom.xml', '<project/>\n');
  put(test1, 'class DiscountTest {}\n');
  writeFakeTool(dir, 'mvnw', { kind: 'maven', ...behavior });
};
const run = (files, extra = {}) => maven.run({ projectDir: dir, sourceDir: dir, files, budgetMs: 20_000, ...extra });

describe('registration', () => {
  it('is selectable by name and never owned or chosen by auto', () => {
    expect(RUNNERS.maven).toBe(maven);
    expect(RUNNER_NAMES).toContain('maven');
    expect(OWNED_RUNNERS.map((r) => r.name)).not.toContain('maven');
  });
});

describe('check', () => {
  it('runs the project wrapper and reports its version as a project runner', async () => {
    project();
    expect(await maven.check({ projectDir: dir })).toEqual({ ok: true, version: '3.9.6', source: 'project' });
  });

  it('falls back to mvn on PATH, reported as a path runner', async () => {
    put('pom.xml', '<project/>\n');
    const bin = join(dir, 'bin');
    writeFakeTool(bin, 'mvn', { kind: 'maven' });
    // the fake reads its behavior from the working directory, which is the project
    setFakeBehavior(dir, { kind: 'maven' });
    expect(await maven.check({ projectDir: dir, env: { PATH: bin } })).toEqual({ ok: true, version: '3.9.6', source: 'path' });
  });

  it('says what is missing and what fixes it when neither exists', async () => {
    put('pom.xml', '<project/>\n');
    const empty = join(dir, 'empty'); mkdirSync(empty);
    const r = await maven.check({ projectDir: dir, env: { PATH: empty } });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/`mvn`.*not found/);
    expect(r.message).toMatch(/install Maven or add a wrapper/);
  });

  it('refuses a project with no pom.xml, without starting anything', async () => {
    writeFakeTool(dir, 'mvnw', { kind: 'maven' });
    const r = await maven.check({ projectDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('pom.xml');
    expect(fakeArgv(dir)).toEqual([]);
  });

  it('a wrapper that fails is named, and PATH is not used behind its back', async () => {
    project({ versionFails: true });
    const r = await maven.check({ projectDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('./mvnw');
    expect(r.message).toContain('boom');
  });

  it('an answer that is not a Maven version is refused', async () => {
    project({ versionText: 'something else\n' });
    const r = await maven.check({ projectDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not report a Maven version/);
  });

  it('ends a --version that hangs at the budget', async () => {
    project({ versionHang: true });
    const started = Date.now();
    const r = await maven.check({ projectDir: dir, budgetMs: 400 });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.ok).toBe(false);
    const pid = Number(readFileSync(join(dir, '.fake-pid'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('checks the directory the run will use, not the original: a scratch copy holds only what git tracks', async () => {
    project();
    const scratch = join(dir, 'scratch'); mkdirSync(scratch);
    const r = await maven.check({ projectDir: scratch, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('pom.xml');
  });
});

describe('the test universe', () => {
  it('lists conventional JUnit files, Java and Kotlin, and nothing else', () => {
    for (const f of [test1, 'src/test/java/demo/PriceTests.java', 'src/test/java/demo/TestSupport.java', 'src/test/kotlin/demo/PriceTest.kt', 'billing/src/test/java/a/InvoiceTest.java']) put(f);
    for (const f of ['src/test/java/demo/Helper.java', 'src/main/java/demo/DiscountTest.java', 'src/test/resources/data.json', 'target/generated/FooTest.java']) put(f);
    expect(maven.tests(dir)).toEqual(['billing/src/test/java/a/InvoiceTest.java', test1, 'src/test/java/demo/PriceTests.java', 'src/test/java/demo/TestSupport.java', 'src/test/kotlin/demo/PriceTest.kt']);
  });

  it('owns the same files, only where a pom.xml is above them', () => {
    put('pom.xml', '<project/>');
    expect(maven.owns(dir, test1)).toBe(true);
    expect(maven.owns(dir, 'src/test/java/demo/Helper.java')).toBe(false);
    expect(maven.owns(dir, 'src/app.test.ts')).toBe(false);
    rmSync(join(dir, 'pom.xml'));
    expect(maven.owns(dir, test1)).toBe(false);
  });

  it('is a manifest bound to the pom.xml files: editing one changes the universe hash', async () => {
    project();
    put('billing/pom.xml', '<project>a</project>');
    const first = await maven.discoverTests({ projectDir: dir, version: '3.9.6' });
    expect(first.files).toEqual([test1]);
    expect(first.configFiles.map((c) => c.path)).toEqual(expect.arrayContaining(['pom.xml', 'billing/pom.xml']));
    put('billing/pom.xml', '<project>b</project>');
    const second = await maven.discoverTests({ projectDir: dir, version: '3.9.6' });
    expect(second.testUniverseHash).not.toBe(first.testUniverseHash);
  });

  it('is selectable by name with a non-empty universe, and an empty one is refused', async () => {
    project();
    const ok = await selectRunner({ projectDir: dir, sourceDir: dir, name: 'maven' });
    expect(ok).toMatchObject({ version: '3.9.6', source: 'project', testFiles: 1 });
    expect(ok.runner).toBe(maven);
    rmSync(join(dir, test1));
    expect((await selectRunner({ projectDir: dir, sourceDir: dir, name: 'maven' })).error).toMatch(/discovered no test files/);
  });

  it('the manifest the engine reads is the adapter\'s own', async () => {
    project();
    const manifest = await discoverRunnerManifest(maven, { version: '3.9.6' }, dir, 5000);
    expect(manifest.runner).toEqual({ name: 'maven', version: '3.9.6' });
  });
});

describe('run', () => {
  it('a green defender passes, and the build is told which class to run', async () => {
    project({ classes: { 'demo.DiscountTest': 'pass' } });
    const r = await run([test1]);
    expect(r.run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
    expect(fakeArgv(dir)[0]).toEqual([expect.stringContaining('mvnw'), '-B', 'test', '-Dtest=demo.DiscountTest', '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false'].slice(1));
  });

  it('an assertion failure is a kill that counts as one; an exception is not an assertion', async () => {
    project({ classes: { 'demo.DiscountTest': 'assert' } });
    expect((await run([test1])).run).toMatchObject({ outcome: 'fail', assertionFailures: 1, exceptionFailures: 0 });
    setFakeBehavior(dir, { kind: 'maven', classes: { 'demo.DiscountTest': 'exception' } });
    expect((await run([test1])).run).toMatchObject({ outcome: 'fail', assertionFailures: 0, exceptionFailures: 1 });
  });

  it('a timeout type is a timeout, never a kill', async () => {
    project({ classes: { 'demo.DiscountTest': 'timeout' } });
    const r = await run([test1]);
    expect(r.timeouts).toBe(1);
    expect(r.run.assertionFailures + r.run.exceptionFailures).toBe(0);
  });

  it('a compile error leaves no report: an error that says why, which the engine reads as fault-invalid', async () => {
    project({ mode: 'compile-error' });
    const r = await run([test1]);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toContain('illegal start of expression');
  });

  it('CONTRACT: a missing report is an error, never a pass', async () => {
    project({ mode: 'no-report' });
    const r = await run([test1]);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/no test report/);
  });

  it('a report left by an earlier run is never read as this run\'s', async () => {
    project({ mode: 'no-report' });
    put('target/surefire-reports/TEST-demo.DiscountTest.xml', '<testsuite name="demo.DiscountTest" tests="1"><testcase name="t" classname="demo.DiscountTest"/></testsuite>');
    const r = await run([test1]);
    expect(r.run.outcome).toBe('error');
    expect(existsSync(join(dir, 'target/surefire-reports'))).toBe(false);
  });

  it('a defender the build did not report is an error, not a pass for the others', async () => {
    project({ classes: { 'demo.DiscountTest': 'pass', 'demo.OtherTest': 'missing' } });
    put('src/test/java/demo/OtherTest.java');
    const r = await run([test1, 'src/test/java/demo/OtherTest.java']);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toContain('demo.OtherTest');
  });

  it('a green report beside a failed build is an error', async () => {
    project({ mode: 'exit1-green', classes: { 'demo.DiscountTest': 'pass' } });
    const r = await run([test1]);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/exited with code 1/);
  });

  it('reads the reports of every module a defender lives in', async () => {
    put('pom.xml', '<project/>'); put('billing/pom.xml', '<project/>');
    put(test1); put('billing/src/test/java/demo/InvoiceTest.java');
    writeFakeTool(dir, 'mvnw', { kind: 'maven', classes: { 'demo.DiscountTest': 'pass', 'demo.InvoiceTest': 'assert' }, modules: { 'demo.InvoiceTest': 'billing' } });
    const r = await run([test1, 'billing/src/test/java/demo/InvoiceTest.java']);
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 1, tests: { total: 2, passed: 1, failed: 1 } });
    expect(fakeArgv(dir)[0]).toContain('.,billing');
  });

  it('refuses a file outside the source set rather than guessing a class', async () => {
    project();
    const r = await run(['DiscountTest.java']);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/not under src\/test\/java or src\/test\/kotlin/);
    expect(fakeArgv(dir)).toEqual([]);
  });

  it('CONTRACT: a hang ends at the budget, with its process gone', async () => {
    project({ mode: 'hang' });
    const started = Date.now();
    const r = await run([test1], { budgetMs: 600, graceMs: 2000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.run.outcome).toBe('timeout');
    expect(r.timeouts).toBe(1);
    expect(r.loadMessage).toMatch(/budget of 600ms exceeded/);
    const pid = Number(readFileSync(join(dir, '.fake-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('under --runner-cmd the adapter steps aside: the command and {out} keep their meaning', async () => {
    project();
    put('writer.cjs', "const fs=require('fs');fs.writeFileSync(process.argv[2],'<testsuite name=\"demo.DiscountTest\" tests=\"1\"><testcase name=\"t\" classname=\"demo.DiscountTest\"/></testsuite>')");
    const r = await maven.run({ projectDir: dir, files: [test1], budgetMs: 20_000, commandTemplate: parseCommandTemplate('node writer.cjs {out} {files}'), reportFormat: 'junit' });
    expect(r.run.outcome).toBe('pass');
    expect(fakeArgv(dir)).toEqual([]);
  });
});

describe('the negative control', () => {
  it('a file replaced by fatalEdit cannot compile as Java or as Kotlin', () => {
    const text = maven.fatalEdit();
    expect(text.length).toBeGreaterThan(0);
    expect(text.trimEnd().endsWith('(')).toBe(true);
    expect(maven.fatalEdit()).toBe(text);
  });
});
