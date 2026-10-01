// @req FR-10
import { describe, it, expect } from 'vitest';
import { parseReport, validateReport } from '../src/probe/runners/node-test.mjs';
import { createReport } from '../src/probe/runners/node/report.mjs';

const item = (extra = {}) => ({ file: 'test/a.test.mjs', name: 'rejects bad input', container: false, suite: false, skipped: false, passed: true, ...extra });
const error = (failureType = 'testCodeFailure', extra = {}) => ({ failureType, code: 'ERR_TEST_FAILURE', message: 'failure', fileExit: false, ...extra });
const envelope = (cases, extra = {}) => ({ schemaVersion: 1, engine: 'node-test', version: process.versions.node, collect: false, complete: true,
  failed: cases.some((t) => !t.passed && !t.skipped), entries: [{ file: '/project/test/a.test.mjs', pid: 123, version: process.versions.node }], cases, ...extra });

describe('native Node structured report contract', () => {
  it('counts a genuine test-body rejection without doubling its failed suite', () => {
    const result = parseReport(envelope([item({ passed: false, error: error() }), item({ name: 'suite', suite: true, passed: false, error: error('subtestsFailed') })]), 5);
    expect(result.run).toEqual({ outcome: 'fail', tests: { total: 1, passed: 0, failed: 1 }, assertionFailures: 1, durationMs: 5 });
    expect(result.failedTests).toEqual(['test/a.test.mjs::rejects bad input']);
  });
  it('gives timeout text inside an assertion no timeout identity', () => {
    const result = parseReport(envelope([item({ passed: false, error: error('testCodeFailure', { message: 'expected "timed out"' }) })]), 1);
    expect(result.run.assertionFailures).toBe(1);
    expect(result.timeouts).toBe(0);
  });
  it('never credits a genuine timeout, even beside a failed assertion', () => {
    const result = parseReport(envelope([item({ passed: false, error: error() }), item({ name: 'hangs', passed: false, error: error('testTimeoutFailure') })]), 1);
    expect(result.timeouts).toBe(1);
    expect(result.run.assertionFailures).toBe(1);
  });
  it.each(['hookFailed', 'cancelledByParent', 'uncaughtException', 'unknown'])('refuses %s as an assertion kill', (failureType) => {
    const result = parseReport(envelope([item({ passed: false, error: error(failureType) }), item({ passed: false, error: error() })]), 1);
    expect(result.run.outcome).toBe('error');
    expect(result.run.assertionFailures).toBe(0);
  });
  it('treats a failing file container as a load failure even if another file asserts', () => {
    const result = parseReport(envelope([item({ container: true, passed: false, error: error('testCodeFailure', { fileExit: true }) }), item({ passed: false, error: error() })]), 1);
    expect(result.run.outcome).toBe('error');
    expect(result.run.assertionFailures).toBe(0);
  });
  it.each([[], [item({ skipped: true })], [item({ container: true })], [item({ suite: true })]].map((cases) => ({ cases })))('refuses a report without an executed test body ($cases)', ({ cases }) => {
    expect(parseReport(envelope(cases), 1).run.outcome).toBe('error');
  });
  it.each([null, {}, { complete: false }, { version: '18.0.0' }, { collect: undefined }, { failed: true }, { entries: [] }, { cases: [{}] }])('rejects malformed or inconsistent envelope fields (%j)', (bad) => {
    const report = bad == null ? bad : { ...envelope([item()]), ...bad };
    if (bad && !Object.keys(bad).length) expect(() => validateReport({})).toThrow();
    else if (bad?.entries) expect(parseReport(report, 1).run.outcome).toBe('error');
    else expect(() => validateReport(report)).toThrow();
  });
  it('does not parse collection as execution or accept duplicate workers', () => {
    expect(() => parseReport(envelope([item()], { collect: true }), 1)).toThrow(/collection/);
    const report = envelope([item()]); report.entries.push(report.entries[0]);
    expect(() => validateReport(report)).toThrow(/receipt/);
  });
  it('preserves empty skip/TODO directives on the Node20 floor', () => {
    const report = createReport({ projectDir: '/project', version: process.versions.node });
    const data = { name: 'skip', nesting: 0, file: '/project/test/a.test.mjs', details: {}, skip: '' };
    report.accept({ type: 'test:start', data }); report.accept({ type: 'test:pass', data });
    expect(report.finish([]).cases[0].skipped).toBe(true);
  });
  it('preserves suite ancestry for declarations imported from another source file', () => {
    const report=createReport({projectDir:'/project',version:process.versions.node});
    const parent={name:'parent',nesting:0,file:'/project/test/a.test.mjs',details:{type:'suite'}};
    const child={name:'child',nesting:1,file:'/project/helpers/case.mjs',details:{}};
    report.accept({type:'test:start',data:parent});report.accept({type:'test:start',data:child});
    report.accept({type:'test:pass',data:child});report.accept({type:'test:pass',data:parent});
    expect(report.finish([]).cases.map((t)=>[t.name,t.suite])).toEqual([['parent > child',false],['parent',true]]);
  });
  it('keeps duplicate-name killer identities distinct using all executed results', () => {
    const cases=[item(),item({passed:false,error:error()})];
    expect(parseReport(envelope(cases),1).failedTests).toEqual(['test/a.test.mjs::rejects bad input [case 2]']);
    cases.reverse();expect(parseReport(envelope(cases),1).failedTests).toEqual(['test/a.test.mjs::rejects bad input [case 1]']);
  });
  it('refuses a stream that ends before a started result completes', () => {
    const report = createReport({ projectDir: '/project', version: process.versions.node });
    report.accept({ type: 'test:start', data: { name: 'unfinished', nesting: 0, file: '/project/test/a.test.mjs' } });
    expect(() => report.finish([])).toThrow(/before every/);
  });
  it('refuses an attribution escape and an end without a start', () => {
    const report = createReport({ projectDir: '/project', version: process.versions.node });
    const data = { name: 'case', nesting: 0, file: '/outside/a.mjs', details: {} };
    expect(() => report.accept({ type: 'test:pass', data })).toThrow(/without its start/);
    report.accept({ type: 'test:start', data });
    expect(() => report.accept({ type: 'test:pass', data })).toThrow(/attribution/);
  });
});
