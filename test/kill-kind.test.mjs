// @req FR-10
// The kill kind and the --require-assertion-kill policy, as pure functions.
// The real-CLI half lives in assertion-policy.cli.test.mjs.
import { describe, it, expect } from 'vitest';
import { classify } from '../src/probe/classify.mjs';
import { isKillRun, killKindOf, killKindReasonOf, killingFailures } from '../src/probe/kill-kind.mjs';
import { assertionPolicyRequest, evaluateAssertionPolicy, isWeakKill, renderAssertionPolicy } from '../src/probe/assertion-policy.mjs';
import { renderRecord } from '../src/render.mjs';
const run = (assertionFailures, exceptionFailures, extra = {}) => ({ outcome: 'fail', assertionFailures, exceptionFailures, timeouts: 0, ...extra });
const pass = { outcome: 'pass', assertionFailures: 0, exceptionFailures: 0, timeouts: 0 };

describe('killKindOf — pure', () => {
  it('assertion: every run had an assertion failure', () => expect(killKindOf([run(1, 0), run(2, 1), run(1, 0)])).toBe('assertion'));
  it('exception-only: no run had one', () => expect(killKindOf([run(0, 1), run(0, 3), run(0, 1)])).toBe('exception-only'));
  it('mixed: some runs had one', () => expect(killKindOf([run(1, 0), run(0, 1), run(1, 0)])).toBe('mixed'));
  it('nothing to classify without a kill run', () => {
    expect(killKindOf([])).toBeUndefined();
    expect(killKindOf([pass, pass])).toBeUndefined();
    expect(killKindOf([{ outcome: 'fail', assertionFailures: 0, exceptionFailures: 0, timeouts: 1 }])).toBeUndefined();
  });
  it('legacy runs without exceptionFailures read as assertion kills', () => expect(killKindOf([{ outcome: 'fail', assertionFailures: 2 }])).toBe('assertion'));
  it('a kill is the sum; a timeout or a pass is not one', () => {
    expect(killingFailures(run(1, 2))).toBe(3);
    expect(isKillRun(run(0, 1))).toBe(true);
    expect(isKillRun(run(1, 0))).toBe(true);
    expect(isKillRun(run(0, 0))).toBe(false);
    expect(isKillRun({ ...pass })).toBe(false);
    expect(isKillRun({ outcome: 'error', assertionFailures: 1, exceptionFailures: 1 })).toBe(false);
  });
});

describe('killKindReasonOf — exception-only because nothing could be read', () => {
  const unread = (n, e = n) => ({ outcome: 'fail', assertionFailures: 0, exceptionFailures: e, kindNotReported: n, timeouts: 0 });
  it('is set when every exception failure in every run went unreported', () => {
    expect(killKindReasonOf([unread(2), unread(1), unread(1)], 'exception-only')).toBe('kind-not-reported-by-runner');
  });
  it('is not set when any exception was a reported exception, or in any single run', () => {
    expect(killKindReasonOf([unread(1, 2), unread(1), unread(1)], 'exception-only')).toBeUndefined();
    expect(killKindReasonOf([unread(1), unread(0, 1), unread(1)], 'exception-only')).toBeUndefined();
    expect(killKindReasonOf([run(0, 1), run(0, 1)], 'exception-only')).toBeUndefined();
  });
  it('is only ever about an exception-only kill', () => {
    expect(killKindReasonOf([unread(1)], 'mixed')).toBeUndefined();
    expect(killKindReasonOf([unread(1)], 'assertion')).toBeUndefined();
    expect(killKindReasonOf([], 'exception-only')).toBeUndefined();
  });
  it('the policy carries it per kill and the line says nothing could be read', () => {
    const rec = (id, reason) => ({ claim: { id }, subject: { id: 'F1' }, verdict: 'killed', detail: { killKind: 'exception-only', ...(reason ? { killKindReason: reason } : {}) } });
    const policy = evaluateAssertionPolicy([rec('A', 'kind-not-reported-by-runner'), rec('B')]);
    expect(policy.exceptionOnlyKills).toEqual([{ claimId: 'A', faultId: 'F1', reason: 'kind-not-reported-by-runner' }, { claimId: 'B', faultId: 'F1' }]);
    expect(renderAssertionPolicy(policy)).toMatch(/A\/F1 \(kind-not-reported-by-runner: the runner reported no error identity.*B\/F1\./);
  });
});

describe('classify — the default verdict is unchanged; the kind rides along', () => {
  const base = { defenders: ['t'], anchor: { status: 'ok' }, baselineRuns: [pass, pass, pass], confirmRuns: 3 };
  it('an exception-only kill is still killed', () => {
    expect(classify({ ...base, probeRuns: [run(0, 1), run(0, 1), run(0, 1)] })).toEqual({ verdict: 'killed', killKind: 'exception-only' });
  });
  it('an assertion kill and a mixed kill are killed with their kind', () => {
    expect(classify({ ...base, probeRuns: [run(1, 0), run(1, 0), run(1, 0)] })).toEqual({ verdict: 'killed', killKind: 'assertion' });
    expect(classify({ ...base, probeRuns: [run(1, 0), run(0, 1), run(1, 0)] })).toEqual({ verdict: 'killed', killKind: 'mixed' });
  });
  it('a failing run with neither kind of failure never kills', () => {
    expect(classify({ ...base, probeRuns: [run(0, 0), pass, pass] }).verdict).toBe('flaky-defender');
  });
});

describe('--require-assertion-kill policy — pure', () => {
  const rec = (claimId, faultId, verdict, killKind) => ({ claim: { id: claimId }, subject: { id: faultId }, verdict, detail: killKind ? { killKind } : {} });
  it('fails on exception-only and on a kill with no recorded kind; passes assertion and mixed; ignores non-kills', () => {
    const records = [rec('B', 'F1', 'killed', 'exception-only'), rec('A', 'F2', 'killed', 'assertion'), rec('A', 'F1', 'killed'), rec('C', 'F1', 'killed', 'mixed'), rec('D', 'F1', 'survived')];
    expect(evaluateAssertionPolicy(records)).toEqual({ state: 'failed', exceptionOnlyKills: [{ claimId: 'A', faultId: 'F1' }, { claimId: 'B', faultId: 'F1' }] });
    expect(isWeakKill(rec('D', 'F1', 'survived'))).toBe(false);
  });
  it('passes when every kill has an assertion', () => {
    expect(evaluateAssertionPolicy([rec('A', 'F1', 'killed', 'assertion')])).toEqual({ state: 'passed', exceptionOnlyKills: [] });
    expect(evaluateAssertionPolicy([])).toEqual({ state: 'passed', exceptionOnlyKills: [] });
  });
  it('is valid only on probe and admit', () => {
    expect(assertionPolicyRequest({}, 'status')).toBe(false);
    expect(assertionPolicyRequest({ 'require-assertion-kill': true }, 'probe')).toBe(true);
    expect(assertionPolicyRequest({ 'require-assertion-kill': true }, 'admit')).toBe(true);
    expect(() => assertionPolicyRequest({ 'require-assertion-kill': true }, 'status')).toThrow(/only valid on probe and admit/);
  });
  it('names the faults beside the failure', () => {
    expect(renderAssertionPolicy({ state: 'failed', exceptionOnlyKills: [{ claimId: 'A', faultId: 'F1' }] })).toMatch(/failed; 1 kill was by exception only.*A\/F1/);
    expect(renderAssertionPolicy({ state: 'passed', exceptionOnlyKills: [] })).toMatch(/passed/);
  });
  it('a rendered record says when it was killed by exception only, and only then', () => {
    const r = (killKind) => ({ verdict: 'killed', claim: { id: 'A', severity: 'high' }, subject: { id: 'F1', file: 'f.mjs', description: 'd' }, detail: { killKind }, defenders: {} });
    expect(renderRecord(r('exception-only'))).toContain('killed by exception only');
    expect(renderRecord(r('assertion'))).not.toContain('exception only');
    expect(renderRecord(r('mixed'))).not.toContain('exception only');
  });
});

