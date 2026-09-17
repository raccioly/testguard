import { describe, it, expect } from 'vitest';
import { parseReport, runProcess } from '../src/probe/runners/shared.mjs';

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

describe('runVitest budget', () => {
  it('kills a process that exceeds the wall-clock budget and reports timeout', async () => {
    const { run } = await runProcess({ argv: () => [],  projectDir: process.cwd(), files: [], budgetMs: 300, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    expect(run.outcome).toBe('timeout');
  }, 5000);

  it('reports error when the command produces no report', async () => {
    const { run, loadMessage } = await runProcess({ argv: () => [],  projectDir: process.cwd(), files: [], budgetMs: 5000, command: [process.execPath, '-e', 'console.error("boom"); process.exit(1)'] });
    expect(run.outcome).toBe('error');
    expect(loadMessage).toBe('boom');
  });
});
