// @req FR-10
import { describe, it, expect } from 'vitest';
import { parseReport } from '../src/probe/runners/shared.mjs';

const file = (status, tests, message) => ({ status, message, assertionResults: tests });
const t = (status, ...failureMessages) => ({ status, failureMessages });

describe('parseReport', () => {
  it('pass', () => {
    const { run } = parseReport({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, testResults: [file('passed', [t('passed'), t('passed')])] }, 10);
    expect(run).toEqual({ outcome: 'pass', tests: { total: 2, passed: 2, failed: 0 }, assertionFailures: 0, durationMs: 10 });
  });

  it('assertion failure counts toward killing', () => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [file('failed', [t('passed'), t('failed', 'AssertionError: expected 1 to be 2')])] }, 10);
    expect(run.outcome).toBe('fail');
    expect(run.assertionFailures).toBe(1);
    expect(timeouts).toBe(0);
  });

  it('a thrown exception in the test body also counts (it is neither timeout nor load failure)', () => {
    const { run } = parseReport({ success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [file('failed', [t('failed', 'TypeError: cannot read properties of undefined')])] }, 10);
    expect(run.assertionFailures).toBe(1);
  });

  it('timeout is separated from assertion failures', () => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 2, numPassedTests: 0, numFailedTests: 2, testResults: [file('failed', [t('failed', 'Error: Test timed out in 1000ms.'), t('failed', 'AssertionError: x')])] }, 10);
    expect(run.assertionFailures).toBe(1);
    expect(timeouts).toBe(1);
  });

  it.each([
    'AssertionError [ERR_ASSERTION]: The input did not match /specify timed out/',
    'AssertionError: expected "Test timed out in 1000ms." to be reported',
    'Error: expected request timed out\nTest timed out in 1000ms.',
    'Error: expected output\n    Exceeded timeout of 5000 ms for a test.',
  ])('does not turn quoted timeout text into a runner timeout: %s', (message) => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [file('failed', [t('failed', message)])] }, 10);
    expect(run.assertionFailures).toBe(1);
    expect(timeouts).toBe(0);
  });

  it.each([
    'Error: Test timed out in 1000ms.',
    'Error: Hook timed out in 1000ms while waiting for a promise.',
    'thrown: "Exceeded timeout of 5000 ms for a test.',
    'Error: Exceeded timeout of 5000 ms for a hook.',
    '\u001b[31mError: Test timed out in 1000ms.\u001b[39m',
    'Error: test timed out after 1000ms',
    'AroundHookSetupError: The setup phase of "aroundEach" hook timed out after 1000ms.',
    'AroundHookTeardownError: The teardown phase of "aroundAll" hook timed out after 1000ms.',
  ])('preserves native runner timeout headers: %s', (message) => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [file('failed', [t('failed', message)])] }, 10);
    expect(run.assertionFailures).toBe(0);
    expect(timeouts).toBe(1);
  });

  it('uses structured assertion identity but never lets it hide a separate timeout', () => {
    const failure = { ...t('failed', 'Test timed out in 1000ms.'), failureDetails: [{ code: 'ERR_ASSERTION', operator: 'match' }] };
    const report = { success: false, numTotalTests: 1, numFailedTests: 1, testResults: [file('failed', [failure])] };
    expect(parseReport(report, 10).timeouts).toBe(0);
    expect(parseReport(report, 10).run.assertionFailures).toBe(1);
    failure.failureMessages.push('Error: Hook timed out in 1000ms.');
    expect(parseReport(report, 10).timeouts).toBe(1);
    expect(parseReport(report, 10).run.assertionFailures).toBe(0);
    failure.failureMessages = ['AssertionError: text'];
    failure.failureType = 'testTimeoutFailure';
    expect(parseReport(report, 10).timeouts).toBe(1);
  });

  it('finds the cause under jest\'s "Test suite failed to run" banner, so a syntax error is named', () => {
    const { run, loadMessage } = parseReport({ success: false, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [file('failed', [], '  ● Test suite failed to run\n\n    SyntaxError: /x/src/redact.js: missing ) after argument list (39:60)\n\n      37 |')] }, 10);
    expect(run.outcome).toBe('error');
    expect(loadMessage).toMatch(/^SyntaxError: .*missing \)/);
  });

  it('a file that failed to load is an error, not a fail', () => {
    const { run, loadMessage } = parseReport({ success: false, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [file('failed', [], 'Failed to parse source\nmore')] }, 10);
    expect(run.outcome).toBe('error');
    expect(loadMessage).toBe('Failed to parse source');
  });
});

