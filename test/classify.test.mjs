// @req FR-03
// @req FR-04
// @req FR-05
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { classify, shouldStopEarly } from '../src/probe/classify.mjs';

const pass = { outcome: 'pass', assertionFailures: 0, timeouts: 0 };
const kill = { outcome: 'fail', assertionFailures: 1, timeouts: 0 };
const tout = { outcome: 'fail', assertionFailures: 0, timeouts: 1 };
const budget = { outcome: 'timeout', assertionFailures: 0, timeouts: 1 };
const err = { outcome: 'error', assertionFailures: 0, timeouts: 0 };
const ok = { status: 'ok' };
const D = ['t.test.mjs'];
const N = 3;

describe('classify — the order of checks is the spec', () => {
  it('nocover before anything else', () =>
    expect(classify({ defenders: [], anchor: { status: 'anchor-missing' }, baselineRuns: [], probeRuns: [], confirmRuns: N })).toEqual({ verdict: 'nocover' }));

  it('unverifiable carries the anchor status as reason', () => {
    expect(classify({ defenders: D, anchor: { status: 'anchor-missing' }, baselineRuns: [], probeRuns: [], confirmRuns: N })).toEqual({ verdict: 'unverifiable', reason: 'anchor-missing' });
    expect(classify({ defenders: D, anchor: { status: 'anchor-ambiguous' }, baselineRuns: [], probeRuns: [], confirmRuns: N }).reason).toBe('anchor-ambiguous');
  });

  it('defenders that failed to LOAD are unverifiable, never flaky', () =>
    expect(classify({ defenders: D, anchor: { status: 'defenders-failed-to-load' }, baselineRuns: [err], probeRuns: [], confirmRuns: N })).toEqual({ verdict: 'unverifiable', reason: 'defenders-failed-to-load' }));

  it('flaky-defender when the baseline is not green N/N', () => {
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, kill], probeRuns: [], confirmRuns: N })).toEqual({ verdict: 'flaky-defender', reason: 'defenders-not-green' });
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [], probeRuns: [], confirmRuns: N }).verdict).toBe('flaky-defender');
  });

  it('fault-invalid when the suite cannot load, naming a parse error when the runner does', () => {
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [err], confirmRuns: N })).toEqual({ verdict: 'fault-invalid', reason: 'suite-failed-to-load' });
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [{ ...err, loadMessage: 'Failed to parse source: invalid JS syntax' }], confirmRuns: N }).reason).toBe('replacement-does-not-compile');
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [{ ...err, loadMessage: 'Transform failed with 1 error: Expected ")" but found ";"' }], confirmRuns: N }).reason).toBe('replacement-does-not-compile');
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [{ ...err, loadMessage: 'Cannot find module ./gone' }], confirmRuns: N }).reason).toBe('suite-failed-to-load');
  });

  it('timeout is never a kill, whether test-level or budget-level', () => {
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [tout], confirmRuns: N }).verdict).toBe('timeout');
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [budget], confirmRuns: N }).verdict).toBe('timeout');
  });

  it('killed only with N/N assertion failures', () =>
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [kill, kill, kill], confirmRuns: N })).toEqual({ verdict: 'killed' }));

  it('survived only with N/N passes', () =>
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [pass, pass, pass], confirmRuns: N })).toEqual({ verdict: 'survived' }));

  it('mixed kill/pass is a flaky defender, not an optimistic kill', () =>
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [kill, pass, kill], confirmRuns: N })).toEqual({ verdict: 'flaky-defender', reason: 'inconsistent-probe' }));

  it('a fail with zero assertion failures and zero timeouts never kills', () =>
    expect(classify({ defenders: D, anchor: ok, baselineRuns: [pass, pass, pass], probeRuns: [{ outcome: 'fail', assertionFailures: 0, timeouts: 0 }, pass, pass], confirmRuns: N }).verdict).toBe('flaky-defender'));
});

describe('shouldStopEarly', () => {
  it('stops on error or timeout, continues otherwise', () => {
    expect(shouldStopEarly([err])).toBe(true);
    expect(shouldStopEarly([budget])).toBe(true);
    expect(shouldStopEarly([tout])).toBe(true);
    expect(shouldStopEarly([kill])).toBe(false);
    expect(shouldStopEarly([pass])).toBe(false);
  });
});

describe('a survivor is unverifiable until the control shows the subject runs', () => {
  // TG-SURVIVOR-PROVES-THE-SUBJECT-RUNS, proved here rather than through a full
  // probe. The claim is about classify(), which is pure — it was defended by
  // negative-control.test.mjs, which spawns real runners against fixture repos
  // and costs ~54 s a claim. The negative control still earns its place as an
  // end-to-end check; this is the same invariant at unit cost.
  //
  // Why it matters: "the defenders never execute this code" is a devastating
  // audit finding, and reporting it when the control was never run would make
  // it a false one. So `false` means proven-unreached and downgrades the
  // verdict, while `undefined` means we did not look and changes nothing.
  const survives = (subjectReached) => classify({
    defenders: D,
    anchor: ok,
    baselineRuns: [pass, pass, pass],
    probeRuns: [pass, pass, pass],
    confirmRuns: N,
    subjectReached,
  });

  it('downgrades a survivor to unverifiable when the subject is proven unreached', () => {
    expect(survives(false)).toEqual({ verdict: 'unverifiable', reason: 'subject-not-executed' });
  });

  it('still reports survived when the control proved the subject IS reached', () => {
    expect(survives(true)).toEqual({ verdict: 'survived' });
  });

  it('leaves the verdict alone when the control was never run', () => {
    // `undefined` is not evidence either way. Treating it as unreached would
    // turn every un-escalated survivor into a false audit finding.
    expect(survives(undefined)).toEqual({ verdict: 'survived' });
  });
});
