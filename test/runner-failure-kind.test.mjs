// @req FR-10
// A failed test is exactly one of: a timeout, an assertion, an exception,
// judged from structured error identity and never from message wording.
// The jest shapes below are copied from a real `jest --json` report; the
// vitest and Playwright identities come from their injected reporters.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReport, isAssertionDetail, failureKind } from '../src/probe/runners/shared.mjs';
import { mergeRuns } from '../src/probe/runners/index.mjs';
import KindsReporter from '../src/probe/runners/vitest/kinds-reporter.mjs';

const REAL_JEST = {
  expectToBe: { matcherResult: { actual: 1, expected: 2, message: 'expect(received).toBe(expected) // Object.is equality', name: 'toBe', pass: false } },
  expectNotToThrow: { matcherResult: { message: 'expect(received).not.toThrow()\n\nError name: "TypeError"', pass: true } },
  nodeAssertRewritten: { message: 'assert.doesNotThrow(function)\n\nExpected the function not to throw an error.' },
  thrownTypeError: {},
  customErrorWithProps: { code: 'E_MY', extra: 1 },
  thrownString: {},
};
const jestFile = (tests) => ({ success: false, numTotalTests: tests.length, numPassedTests: 0, numFailedTests: tests.length, testResults: [{ name: '/p/a.test.js', status: 'failed', assertionResults: tests.map(([title, details, msg = 'x']) => ({ title, fullName: title, ancestorTitles: [], status: 'failed', failureMessages: [msg], failureDetails: details === undefined ? undefined : [details] })) }] });

describe('isAssertionDetail — structured identity only', () => {
  it.each([
    ['jest matcher result', REAL_JEST.expectToBe, true],
    ['jest .not.toThrow() matcher result', REAL_JEST.expectNotToThrow, true],
    ['node:assert rewritten by jest-circus', REAL_JEST.nodeAssertRewritten, true],
    ['AssertionError by name', { name: 'AssertionError' }, true],
    ['ERR_ASSERTION by code', { code: 'ERR_ASSERTION' }, true],
    ['an operator', { operator: 'strictEqual' }, true],
    ['a thrown TypeError', REAL_JEST.thrownTypeError, false],
    ['a custom error with its own code', REAL_JEST.customErrorWithProps, false],
    ['a message-only shape plus other keys', { message: 'AssertionError: x', extra: 1 }, false],
    ['null', null, false],
    ['a string', 'AssertionError', false],
    ['a matcherResult that is not an object', { matcherResult: 'yes' }, false],
  ])('%s', (_name, detail, expected) => expect(isAssertionDetail(detail)).toBe(expected));
  it('failureKind: any assertion wins; no details at all is an exception', () => {
    expect(failureKind([{}, REAL_JEST.expectToBe])).toBe('assertion');
    expect(failureKind([{}])).toBe('exception');
    expect(failureKind([])).toBe('exception');
    expect(failureKind(undefined)).toBe('exception');
  });
});

describe('parseReport — jest failureDetails', () => {
  it('splits a real-shaped report; message wording never decides', () => {
    const r = parseReport(jestFile([
      ['expect.toBe', REAL_JEST.expectToBe, 'Error: expect(received).toBe(expected)'],
      ['not.toThrow', REAL_JEST.expectNotToThrow],
      ['assert.doesNotThrow', REAL_JEST.nodeAssertRewritten],
      ['throws TypeError', REAL_JEST.thrownTypeError, 'AssertionError: this text lies'],
      ['throws string', REAL_JEST.thrownString],
    ]), 5);
    expect(r.run).toMatchObject({ outcome: 'fail', assertionFailures: 3, exceptionFailures: 2 });
    expect(r.timeouts).toBe(0);
  });
  it('a timeout is counted as neither', () => {
    const r = parseReport(jestFile([['hangs', {}, 'thrown: "Exceeded timeout of 5000 ms for a test."'], ['asserts', REAL_JEST.expectToBe]]), 5);
    expect(r.run).toMatchObject({ assertionFailures: 1, exceptionFailures: 0 });
    expect(r.timeouts).toBe(1);
  });
  it('a report with no failureDetails at all (a custom --runner-cmd) is the pessimistic side', () => {
    const r = parseReport(jestFile([['a', undefined, 'AssertionError: expected 1 to be 2'], ['b', undefined]]), 5);
    expect(r.run).toMatchObject({ assertionFailures: 0, exceptionFailures: 2 });
  });
});

describe('parseReport — the vitest sidecar', () => {
  const report = { success: false, numTotalTests: 3, numPassedTests: 0, numFailedTests: 3, testResults: [{ name: '/p/v.test.mjs', status: 'failed', assertionResults: [
    { title: 'expects', fullName: 'suite expects', ancestorTitles: ['suite'], status: 'failed', failureMessages: ['AssertionError: x'] },
    { title: 'throws', fullName: 'suite throws', ancestorTitles: ['suite'], status: 'failed', failureMessages: ['TypeError: boom'] },
    { title: 'top', fullName: 'top', ancestorTitles: [], status: 'failed', failureMessages: ['Error: Test timed out in 5000ms.'] },
  ] }] };
  const kinds = (tests) => ({ version: 1, tests: tests.map(([path, kind]) => ({ file: '/p/v.test.mjs', path, kind })) });
  it('joins failed tests to their kind by file and title path', () => {
    const r = parseReport(report, 1, kinds([[['suite', 'expects'], 'assertion'], [['suite', 'throws'], 'exception'], [['top'], 'assertion']]));
    expect(r.run).toMatchObject({ assertionFailures: 1, exceptionFailures: 1 });
    expect(r.timeouts).toBe(1);
  });
  it('no sidecar: every failure is an exception, whatever the stack text says', () => {
    for (const k of [undefined, null, {}, { tests: 'x' }]) expect(parseReport(report, 1, k).run).toMatchObject({ assertionFailures: 0, exceptionFailures: 2 });
  });
});

describe('the vitest kinds reporter', () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.TESTGUARD_VITEST_KINDS; });
  const sidecar = () => { const d = mkdtempSync(join(tmpdir(), 'tg-kinds-')); dirs.push(d); process.env.TESTGUARD_VITEST_KINDS = join(d, 'k.json'); return process.env.TESTGUARD_VITEST_KINDS; };
  const errors = { assertion: [{ name: 'AssertionError', message: 'expected 1 to be 2' }], nodeAssert: [{ name: 'Error', code: 'ERR_ASSERTION' }], exception: [{ name: 'TypeError', message: 'boom' }], bare: [{ message: 'str' }] };

  it('vitest >= 3: reads test results from the module tree', () => {
    const out = sidecar();
    const test = (name, state, errs, parent) => ({ type: 'test', name, parent, result: () => ({ state, errors: errs }) });
    const suite = { type: 'suite', name: 'suite', parent: { type: 'module' } };
    const module = { moduleId: '/p/v.test.mjs', children: { allTests: () => [test('a', 'failed', errors.assertion, suite), test('b', 'failed', errors.nodeAssert, suite), test('c', 'failed', errors.exception, suite), test('d', 'failed', errors.bare, suite), test('e', 'passed', [], suite)] } };
    new KindsReporter().onTestRunEnd([module]);
    expect(JSON.parse(readFileSync(out, 'utf8')).tests).toEqual([
      { file: '/p/v.test.mjs', path: ['suite', 'a'], kind: 'assertion' },
      { file: '/p/v.test.mjs', path: ['suite', 'b'], kind: 'assertion' },
      { file: '/p/v.test.mjs', path: ['suite', 'c'], kind: 'exception' },
      { file: '/p/v.test.mjs', path: ['suite', 'd'], kind: 'exception' },
    ]);
  });
  it('vitest < 3: reads the task tree; writes once even when both hooks fire', () => {
    const out = sidecar();
    const reporter = new KindsReporter();
    const files = [{ type: 'suite', name: '/p/v.test.mjs', tasks: [{ type: 'suite', name: 'suite', tasks: [{ type: 'test', name: 'a', file: { filepath: '/p/v.test.mjs' }, result: { state: 'fail', errors: errors.assertion } }, { type: 'test', name: 'b', file: { filepath: '/p/v.test.mjs' }, result: { state: 'fail', errors: errors.exception } }] }] }];
    reporter.onFinished(files);
    reporter.onTestRunEnd([]);
    expect(JSON.parse(readFileSync(out, 'utf8')).tests).toEqual([
      { file: '/p/v.test.mjs', path: ['suite', 'a'], kind: 'assertion' },
      { file: '/p/v.test.mjs', path: ['suite', 'b'], kind: 'exception' },
    ]);
  });
  it('writes nothing when TestGuard did not ask for it', () => {
    delete process.env.TESTGUARD_VITEST_KINDS;
    expect(() => new KindsReporter().onFinished([])).not.toThrow();
  });
});

describe('mergeRuns carries both counts', () => {
  const part = (a, e) => ({ run: { outcome: 'fail', tests: { total: 2, passed: 0, failed: 2 }, assertionFailures: a, exceptionFailures: e, durationMs: 1 }, timeouts: 0, failedTests: [] });
  it('adds assertion and exception failures separately', () => {
    expect(mergeRuns([part(1, 0), part(0, 2)]).run).toMatchObject({ assertionFailures: 1, exceptionFailures: 2 });
  });
  it('a part from an older reporter without exceptionFailures counts as zero', () => {
    const legacy = part(1, 0); delete legacy.run.exceptionFailures;
    expect(mergeRuns([legacy, part(0, 1)]).run).toMatchObject({ assertionFailures: 1, exceptionFailures: 1 });
  });
});
