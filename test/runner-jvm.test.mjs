// The pure parts of the JVM adapters (#329): which class a test file is, which
// module owns it, where its reports are, and how a run's evidence is judged.
// Nothing here starts a process; the fake-executable runs are in
// runner-maven.test.mjs and runner-gradle.test.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  testClassOf, moduleOf, groupByModule, reportDirsFor, clearReports, listReportFiles, evaluateJvmRun, firstBuildError,
  mavenVersion, gradleVersion, JAVA_TEST_GLOBS, KOTLIN_TEST_GLOBS, isJvmTestPath, hasBuildFile,
} from '../src/probe/runners/jvm.mjs';
import { junitToReport } from '../src/probe/runners/junit.mjs';

let dir;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-jvm-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

describe('testClassOf: a test file is the class the build tool selects', () => {
  it.each([
    ['src/test/java/demo/DiscountTest.java', 'demo.DiscountTest'],
    ['billing/src/test/java/com/acme/billing/InvoiceTests.java', 'com.acme.billing.InvoiceTests'],
    ['src/test/kotlin/demo/PriceTest.kt', 'demo.PriceTest'],
    ['src/test/java/TopLevelTest.java', 'TopLevelTest'],
    ['a/b/src/test/java/x/y/TestSupport.java', 'x.y.TestSupport'],
  ])('%s is %s', (file, cls) => expect(testClassOf(file)).toBe(cls));

  it.each(['src/main/java/demo/Discount.java', 'src/test/resources/data.json', 'DiscountTest.java', 'src/test/java/demo/Notes.txt'])('%s is no test class', (file) => {
    expect(testClassOf(file)).toBeNull();
  });
});

describe('isJvmTestPath: the conventional test classes, and only under the source set', () => {
  it.each([
    'src/test/java/demo/DiscountTest.java', 'src/test/java/demo/PriceTests.java', 'src/test/java/demo/FooTestCase.java',
    // Surefire's own default include is `**/Test*.java`, so any name that starts with Test is in the universe
    'src/test/java/demo/TestSupport.java', 'src/test/java/demo/Testament.java', 'src/test/kotlin/demo/PriceTest.kt', 'billing/src/test/java/a/InvoiceTest.java',
  ])('%s is a test', (file) => expect(isJvmTestPath(file)).toBe(true));

  it.each([
    'src/test/java/demo/Helper.java', 'src/test/java/demo/Contest.java', 'src/main/java/demo/DiscountTest.java',
    'src/test/resources/FooTest.json', 'DiscountTest.java',
  ])('%s is not', (file) => expect(isJvmTestPath(file)).toBe(false));
});

describe('hasBuildFile: a build file in the directory of the file, or above it', () => {
  it('finds one at the root, in a module and not in a sibling', () => {
    put('billing/pom.xml');
    expect(hasBuildFile(dir, 'billing/src/test/java/a/ATest.java', ['pom.xml'])).toBe(true);
    expect(hasBuildFile(dir, 'shipping/src/test/java/a/BTest.java', ['pom.xml'])).toBe(false);
    put('pom.xml');
    expect(hasBuildFile(dir, 'shipping/src/test/java/a/BTest.java', ['pom.xml'])).toBe(true);
    expect(hasBuildFile(dir, 'src/test/java/a/BTest.java', ['build.gradle'])).toBe(false);
  });
});

describe('the test globs', () => {
  it('list the Surefire default names under src/test/java and the Kotlin ones under src/test/kotlin', () => {
    expect(JAVA_TEST_GLOBS).toEqual(expect.arrayContaining(['**/src/test/java/**/*Test.java', '**/src/test/java/**/*Tests.java', '**/src/test/java/**/Test*.java']));
    expect(KOTLIN_TEST_GLOBS).toEqual(expect.arrayContaining(['**/src/test/kotlin/**/*Test.kt']));
  });
});

describe('moduleOf: the nearest directory with a build file', () => {
  it('is the directory of the nearest pom.xml, or the project root', () => {
    put('pom.xml'); put('billing/pom.xml'); put('billing/api/pom.xml');
    expect(moduleOf(dir, 'billing/api/src/test/java/a/ATest.java', ['pom.xml'])).toBe('billing/api');
    expect(moduleOf(dir, 'billing/src/test/java/a/BTest.java', ['pom.xml'])).toBe('billing');
    expect(moduleOf(dir, 'shipping/src/test/java/a/CTest.java', ['pom.xml'])).toBe('');
  });

  it('is the root when no build file exists at all', () => {
    expect(moduleOf(dir, 'src/test/java/a/ATest.java', ['pom.xml'])).toBe('');
  });

  it('groups files by module in a stable order', () => {
    put('pom.xml'); put('b/pom.xml'); put('a/pom.xml');
    const groups = groupByModule(dir, ['b/src/test/java/x/BTest.java', 'src/test/java/x/RootTest.java', 'a/src/test/java/x/ATest.java', 'a/src/test/java/x/A2Test.java'], ['pom.xml']);
    expect([...groups]).toEqual([
      ['', ['src/test/java/x/RootTest.java']],
      ['a', ['a/src/test/java/x/A2Test.java', 'a/src/test/java/x/ATest.java']],
      ['b', ['b/src/test/java/x/BTest.java']],
    ]);
  });
});

describe('reportDirsFor', () => {
  it('maven reads Surefire and Failsafe, gradle reads the test task, each under the module', () => {
    expect(reportDirsFor('maven', '')).toEqual(['target/surefire-reports', 'target/failsafe-reports']);
    expect(reportDirsFor('maven', 'billing')).toEqual(['billing/target/surefire-reports', 'billing/target/failsafe-reports']);
    expect(reportDirsFor('gradle', '')).toEqual(['build/test-results/test']);
    expect(reportDirsFor('gradle', 'a/b')).toEqual(['a/b/build/test-results/test']);
  });
});

describe('a report left by an earlier run is never this run\'s report', () => {
  it('clearReports removes the directories and nothing else', () => {
    put('target/surefire-reports/TEST-demo.OldTest.xml', '<testsuite/>');
    put('target/classes/demo/A.class', 'x');
    clearReports(dir, ['target/surefire-reports', 'target/failsafe-reports']);
    expect(existsSync(join(dir, 'target/surefire-reports'))).toBe(false);
    expect(existsSync(join(dir, 'target/classes/demo/A.class'))).toBe(true);
  });

  it('listReportFiles ignores a file older than the run, a link, and a file that is not xml', () => {
    put('target/surefire-reports/TEST-demo.NewTest.xml', '<testsuite/>');
    put('target/surefire-reports/TEST-demo.OldTest.xml', '<testsuite/>');
    put('target/surefire-reports/demo.NewTest.txt', 'text');
    const old = new Date(Date.now() - 600_000);
    utimesSync(join(dir, 'target/surefire-reports/TEST-demo.OldTest.xml'), old, old);
    const found = listReportFiles(dir, ['target/surefire-reports', 'target/failsafe-reports'], Date.now() - 5000);
    expect(found.map((f) => f.slice(dir.length + 1))).toEqual(['target/surefire-reports/TEST-demo.NewTest.xml']);
  });

  it('is empty when no directory exists', () => {
    expect(listReportFiles(dir, ['target/surefire-reports'], 0)).toEqual([]);
  });
});

const suite = (name, cases) => `<testsuite name="${name}" tests="${cases.length}">${cases.join('')}</testsuite>`;
const pass = (cls, name = 'ok') => `<testcase name="${name}" classname="${cls}"/>`;
const fail = (cls, type, name = 'bad') => `<testcase name="${name}" classname="${cls}"><failure message="m" type="${type}">t</failure></testcase>`;
const report = (...suites) => junitToReport(suites);

describe('evaluateJvmRun: a build is judged by its reports and its exit status together', () => {
  const base = { durationMs: 7, requested: ['demo.DiscountTest'], stdout: '' };

  it('a green report and a clean exit is a pass', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest', [pass('demo.DiscountTest')])), exit: 0 });
    expect(r.run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
  });

  it('an assertion failure is a failed run that counts as an assertion', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest', [fail('demo.DiscountTest', 'org.opentest4j.AssertionFailedError')])), exit: 1 });
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 1, exceptionFailures: 0 });
  });

  it('an exception is a failed run that does not count as an assertion', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest', [fail('demo.DiscountTest', 'java.lang.NullPointerException')])), exit: 1 });
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 0, exceptionFailures: 1 });
  });

  it('no report at all is an error that carries the build\'s own words', () => {
    const stdout = '[INFO] Compiling 1 source file\n[ERROR] COMPILATION ERROR :\n[ERROR] /w/src/main/java/demo/Discount.java:[5,9] illegal start of expression\n[INFO] BUILD FAILURE\n';
    const r = evaluateJvmRun({ ...base, report: null, exit: 1, stdout });
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toContain('illegal start of expression');
    expect(r.failedTests).toEqual([]);
  });

  it('no report and no output still says why', () => {
    const r = evaluateJvmRun({ ...base, report: null, exit: 127, stdout: '' });
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/no test report/);
    expect(r.loadMessage).toMatch(/127/);
  });

  it('a green report beside a failed build is an error, never a pass: another module may not have built', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest', [pass('demo.DiscountTest')])), exit: 1, stdout: '[ERROR] Failed to execute goal on project api' });
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/exited with code 1/);
    expect(r.loadMessage).toContain('Failed to execute goal on project api');
  });

  it('a defender with no suite in the reports is an error naming it', () => {
    const r = evaluateJvmRun({ ...base, requested: ['demo.DiscountTest', 'demo.OtherTest'], report: report(suite('demo.DiscountTest', [pass('demo.DiscountTest')])), exit: 0 });
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toContain('demo.OtherTest');
  });

  it('a nested class counts as its outer class having run', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest$Members', [pass('demo.DiscountTest$Members')])), exit: 0 });
    expect(r.run.outcome).toBe('pass');
  });

  it('a class that merely shares a prefix is not the requested class', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTestExtra', [pass('demo.DiscountTestExtra')])), exit: 0 });
    expect(r.run.outcome).toBe('error');
  });

  it('a suite that errors and ran no test is an error, not a kill', () => {
    const broken = '<testsuite name="demo.DiscountTest" tests="0" errors="1"><error message="class not found" type="java.lang.ClassNotFoundException"/></testsuite>';
    const r = evaluateJvmRun({ ...base, report: report(broken), exit: 1 });
    expect(r.run).toMatchObject({ outcome: 'error', assertionFailures: 0 });
  });

  it('a timeout type never counts as a kill', () => {
    const r = evaluateJvmRun({ ...base, report: report(suite('demo.DiscountTest', [fail('demo.DiscountTest', 'java.util.concurrent.TimeoutException')])), exit: 1 });
    expect(r.timeouts).toBe(1);
    expect(r.run.assertionFailures).toBe(0);
  });

  it('a signal exit is named', () => {
    const r = evaluateJvmRun({ ...base, report: null, exit: 'signal SIGKILL', stdout: '' });
    expect(r.loadMessage).toContain('signal SIGKILL');
  });
});

describe('firstBuildError: the line a person needs from a build log', () => {
  it('prefers the compiler\'s own line', () => {
    expect(firstBuildError('[ERROR] COMPILATION ERROR :\n[ERROR] /w/A.java:[3,1] class, interface, enum, or record expected\n[ERROR] Failed to execute goal x')).toBe('/w/A.java:[3,1] class, interface, enum, or record expected');
  });
  it('reads a Gradle compiler line', () => {
    expect(firstBuildError('> Task :compileJava FAILED\n/w/A.java:3: error: class, interface, enum, or record expected\n')).toBe('/w/A.java:3: error: class, interface, enum, or record expected');
  });
  it('reads a Kotlin compiler line', () => {
    expect(firstBuildError('e: file:///w/P.kt:3:1 Expecting a top level declaration\n')).toBe('e: file:///w/P.kt:3:1 Expecting a top level declaration');
  });
  it('reads what went wrong', () => {
    expect(firstBuildError('FAILURE: Build failed with an exception.\n\n* What went wrong:\nNo tests found for given includes: [demo.XTest]\n')).toBe('No tests found for given includes: [demo.XTest]');
  });
  it('falls back to the first Maven error, then to null', () => {
    expect(firstBuildError('[INFO] x\n[ERROR] No tests matching pattern "XTest" were executed!\n')).toBe('No tests matching pattern "XTest" were executed!');
    expect(firstBuildError('all fine\n')).toBeNull();
    expect(firstBuildError('')).toBeNull();
  });
  it('strips color codes and ignores the help footer', () => {
    expect(firstBuildError('\u001b[1;31m[ERROR]\u001b[m boom\n[ERROR] -> [Help 1]\n')).toBe('boom');
  });
});

describe('version lines', () => {
  it('maven', () => {
    expect(mavenVersion('Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)\nMaven home: /opt\n')).toBe('3.9.6');
    expect(mavenVersion('Downloading https://x\nApache Maven 4.0.0-rc-1 (abc)\n')).toBe('4.0.0-rc-1');
    expect(mavenVersion('mvn: command not found')).toBeNull();
  });
  it('gradle', () => {
    expect(gradleVersion('\n------------------------------------------------------------\nGradle 8.5\n------------------------------------------------------------\n')).toBe('8.5');
    expect(gradleVersion('Gradle 9.0.0-rc-1\n')).toBe('9.0.0-rc-1');
    expect(gradleVersion('nothing')).toBeNull();
  });
});
