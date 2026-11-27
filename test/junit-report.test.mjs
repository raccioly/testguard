// The JUnit XML reader (#329): one report format that Maven (Surefire and
// Failsafe), Gradle, `pytest --junitxml`, Karma and the Salesforce CLI all
// write. It turns the XML into the jest-compatible report `parseReport` reads,
// so every rule about a kill (timeouts never kill, a load failure is an
// error, an unreported kind is an exception) stays in one place.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitToReport, readJunitReport, scanXml, isAssertionType, ASSERTION_TYPES } from '../src/probe/runners/junit.mjs';
import { parseReport } from '../src/probe/runners/shared.mjs';

const fixture = (...parts) => join(import.meta.dirname, 'fixtures', 'junit', ...parts);
const text = (...parts) => readFileSync(fixture(...parts), 'utf8');
const parse = (report) => parseReport(report, 10);

describe('a Surefire report', () => {
  const report = junitToReport([text('surefire', 'TEST-demo.DiscountTest.xml')]);
  const { run, failedTests } = parse(report);

  it('maps testsuite to a test file entry and testcase to an assertion result', () => {
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0].name).toBe('demo.DiscountTest');
    expect(report.testResults[0].assertionResults.map((t) => [t.title, t.status])).toEqual([
      ['memberGetsTenPercent()', 'passed'], ['nonMemberPaysFull()', 'failed'], ['rejectsNegative()', 'failed'],
      ['legacyJunit4Style()', 'failed'], ['disabledForNow()', 'pending'],
    ]);
    expect(report).toMatchObject({ numTotalTests: 5, numPassedTests: 1, numFailedTests: 3, success: false });
  });

  it('counts failure and error as failed, skipped as neither', () => {
    expect(run.outcome).toBe('fail');
    expect(run.tests).toEqual({ total: 5, passed: 1, failed: 3 });
    expect(failedTests).toHaveLength(3);
  });

  it('reads assertion against exception from the structured type attribute', () => {
    // two assertion types (opentest4j, junit.framework) and one NullPointerException
    expect(run.assertionFailures).toBe(2);
    expect(run.exceptionFailures).toBe(1);
    expect(run.kindNotReported).toBeUndefined();
  });

  it('decodes entities in the message', () => {
    const failed = report.testResults[0].assertionResults.find((t) => t.title === 'rejectsNegative()');
    expect(failed.failureMessages[0]).toContain('boom & more');
  });
});

describe('a Failsafe report', () => {
  it('reads the passing suite, and never counts a testcase that sits in a CDATA block, a property value or a comment', () => {
    const report = junitToReport([text('failsafe', 'TEST-demo.CheckoutIT.xml')]);
    expect(report.numTotalTests).toBe(2);
    const { run } = parse(report);
    expect(run).toMatchObject({ outcome: 'pass', tests: { total: 2, passed: 2, failed: 0 }, assertionFailures: 0, exceptionFailures: 0 });
  });
});

describe('the assertion rule never leans optimistic', () => {
  it('knows the Java and Python assertion types, exactly', () => {
    for (const type of ['org.opentest4j.AssertionFailedError', 'java.lang.AssertionError', 'junit.framework.AssertionFailedError', 'AssertionFailedError', 'AssertionError']) {
      expect(isAssertionType(type), type).toBe(true);
    }
    // a subclass name, a lookalike and an ordinary exception are all exceptions
    for (const type of ['java.lang.NullPointerException', 'com.example.MyAssertionError', 'AssertionErrorHandler', 'assertionerror', '', undefined]) {
      expect(isAssertionType(type), String(type)).toBe(false);
    }
    expect(ASSERTION_TYPES).toContain('System.AssertException');
  });

  it('with no type attribute, reads only the exception class at the head of the message', () => {
    const report = junitToReport([text('testsuites', 'junit.xml')]);
    const byTitle = Object.fromEntries(report.testResults[0].assertionResults.map((t) => [t.title, t]));
    expect(byTitle.test_header_names_the_class.failureDetails).toEqual([{ name: 'AssertionError' }]);
    expect(byTitle.test_apex_style.failureDetails).toEqual([{ name: 'AssertionError' }]);
    // pytest's own rewritten message names no class: unknown, so an exception
    expect(byTitle.test_bare_assert.failureDetails).not.toEqual([{ name: 'AssertionError' }]);
    const { run } = parse(report);
    expect(run.assertionFailures).toBe(2);
    expect(run.exceptionFailures).toBe(1);
  });

  it('a message that merely mentions an assertion class is an exception', () => {
    const xml = '<testsuite name="s" tests="1" failures="1"><testcase name="t"><failure message="wrapped: java.lang.AssertionError: x">trace</failure></testcase></testsuite>';
    expect(parse(junitToReport([xml])).run).toMatchObject({ assertionFailures: 0, exceptionFailures: 1 });
  });

  it('a type that is not an assertion wins over a message that looks like one', () => {
    const xml = '<testsuite name="s" tests="1" errors="1"><testcase name="t"><error type="java.io.IOException" message="AssertionError: nope"/></testcase></testsuite>';
    expect(parse(junitToReport([xml])).run).toMatchObject({ assertionFailures: 0, exceptionFailures: 1 });
  });

  it('a timeout type never kills', () => {
    const xml = '<testsuite name="s" tests="1" errors="1"><testcase name="t"><error type="org.junit.runners.model.TestTimedOutException" message="test timed out after 100 milliseconds"/></testcase></testsuite>';
    const result = parse(junitToReport([xml]));
    expect(result.timeouts).toBe(1);
    expect(result.run).toMatchObject({ assertionFailures: 0, exceptionFailures: 0 });
  });
});

describe('what is not a test result', () => {
  it('a suite with errors and no testcase is a load failure, and says why', () => {
    const report = junitToReport([text('load-failure', 'TEST-demo.BrokenTest.xml')]);
    const result = parse(report);
    expect(result.run.outcome).toBe('error');
    expect(result.loadMessage).toMatch(/Could not initialize class demo\.Config/);
  });

  it('an empty suite is an error, never a pass', () => {
    const result = parse(junitToReport([text('empty', 'TEST-demo.NothingTest.xml')]));
    expect(result.run.outcome).toBe('error');
    expect(result.run.tests.total).toBe(0);
    expect(result.loadMessage).toMatch(/no tests/);
  });

  it('a failure and a load failure in two files is still an error', () => {
    const result = parse(junitToReport([text('surefire', 'TEST-demo.DiscountTest.xml'), text('load-failure', 'TEST-demo.BrokenTest.xml')]));
    expect(result.run.outcome).toBe('error');
  });

  it('refuses a document that is not a JUnit report', () => {
    expect(() => junitToReport([text('not-junit', 'pom.xml')])).toThrow(/no <testsuite> element/);
    expect(() => junitToReport([])).toThrow(/no <testsuite> element/);
  });

  it('refuses a truncated document instead of reading what survived', () => {
    expect(() => junitToReport([text('truncated', 'TEST-demo.CutTest.xml')])).toThrow(/truncated/);
  });

  it('reads suites under a testsuites wrapper, and a nested suite once', () => {
    const xml = '<testsuites><testsuite name="outer"><testsuite name="inner"><testcase name="a"/></testsuite></testsuite></testsuites>';
    const report = junitToReport([xml]);
    expect(report.testResults.map((f) => f.name)).toEqual(['inner']);
    expect(report.numTotalTests).toBe(1);
  });
});

describe('the scanner is tolerant of what real reporters write', () => {
  it('reads single quotes, a doctype, a processing instruction, character references and stray angle brackets', () => {
    const xml = `<?xml version='1.0'?><!DOCTYPE x><testsuite name='a &#x26; b'><testcase name='x &lt; y'><failure message='1 < 2 &#65;'>body</failure></testcase></testsuite>`;
    const report = junitToReport([xml]);
    expect(report.testResults[0].name).toBe('a & b');
    expect(report.testResults[0].assertionResults[0].title).toBe('x < y');
    expect(report.testResults[0].assertionResults[0].failureMessages[0]).toContain('1 < 2 A');
  });

  it('does not recurse: a very deep document does not overflow the stack', () => {
    const deep = `<testsuite name="s">${'<g>'.repeat(50_000)}${'</g>'.repeat(50_000)}<testcase name="t"/></testsuite>`;
    expect(() => scanXml(deep)).not.toThrow();
    expect(junitToReport([deep]).numTotalTests).toBe(1);
  });
});

describe('reading {out}', () => {
  it('reads a single file', () => {
    const report = readJunitReport(fixture('surefire', 'TEST-demo.DiscountTest.xml'));
    expect(report.numTotalTests).toBe(5);
  });

  it('reads a directory of reports, TEST-*.xml and any other .xml, and ignores what is not XML', () => {
    const report = readJunitReport(fixture('dir'));
    expect(report.testResults.map((f) => f.name)).toEqual(['demo.CartTest', 'demo.CheckoutIT', 'demo.PlainNameTest']);
    const { run } = parse(report);
    expect(run).toMatchObject({ outcome: 'fail', tests: { total: 4, passed: 3, failed: 1 }, assertionFailures: 1 });
  });

  it('a directory with no XML file, or only XML that is not a report, is unreadable, never a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-junit-'));
    try {
      expect(() => readJunitReport(dir)).toThrow(/no \.xml report/);
      writeFileSync(join(dir, 'pom.xml'), text('not-junit', 'pom.xml'));
      expect(() => readJunitReport(dir)).toThrow(/no <testsuite> element/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a report over the size bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-junit-'));
    try {
      writeFileSync(join(dir, 'big.xml'), `<testsuite name="s">${'x'.repeat(2048)}</testsuite>`);
      expect(() => readJunitReport(dir, { maxBytes: 1024 })).toThrow(/exceed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
