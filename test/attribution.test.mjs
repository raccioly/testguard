// @req FR-04
// @req NFR-05
// @req NFR-06
import { describe, it, expect } from 'vitest';
import { escalationStart, foldEscalationRun, escalationResult, flakeRate, killersFromRuns, subjectOf, isReusable } from '../src/probe/attribution.mjs';
import { sha256 } from '../src/util/hash.mjs';

/** A spec `testRun`. `kill` means a genuine assertion failure, which is the only thing that can attribute. */
const run = (outcome, assertionFailures = 0) => ({ outcome, tests: { total: 3, passed: outcome === 'pass' ? 3 : 2, failed: outcome === 'pass' ? 0 : 1 }, assertionFailures, durationMs: 1 });
const kill = () => run('fail', 1);
const fold = (...steps) => steps.reduce(foldEscalationRun, escalationStart());

describe('escalation attribution — a killer must fail in every run', () => {
  it('names a test that failed in all N runs, and only that test', () => {
    const s = fold(
      { run: kill(), failedTests: ['a.test.mjs::x', 'b.test.mjs::y'] },
      { run: kill(), failedTests: ['a.test.mjs::x', 'c.test.mjs::z'] },
      { run: kill(), failedTests: ['a.test.mjs::x'] },
    );
    const r = escalationResult(s, 3);
    expect(r.undeclaredKillers).toEqual(['a.test.mjs::x']);
    expect(r.reason).toBe('killed-by-undeclared-tests');
    expect(r.escalationStoppedEarly).toBeUndefined();
    expect(r.escalationRuns).toHaveLength(3);
  });

  it('attributes nothing when a test failed in some runs but not all — the flaky-elsewhere case the N-run rule exists for', () => {
    const s = fold(
      { run: kill(), failedTests: ['flaky.test.mjs::x'] },
      { run: kill(), failedTests: ['other.test.mjs::y'] },
    );
    expect(s.killers.size).toBe(0);
    expect(s.stoppedEarly).toBe('no-common-failure');
    const r = escalationResult(s, 3);
    expect(r.undeclaredKillers).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });

  it('records why it stopped early, so one escalation entry at --confirm 3 is explained rather than suspicious', () => {
    const s = fold({ run: kill(), failedTests: [] });
    expect(s.stoppedEarly).toBe('no-common-failure');
    expect(escalationResult(s, 3).escalationStoppedEarly).toBe('no-common-failure');
  });

  it('never attributes on fewer than N runs, even when a killer is common to the runs it did make', () => {
    const s = fold(
      { run: kill(), failedTests: ['a.test.mjs::x'] },
      { run: kill(), failedTests: ['a.test.mjs::x'] },
    );
    expect(s.killers.size).toBe(1);
    expect(escalationResult(s, 3).undeclaredKillers).toBeUndefined();  // 2 of 3
    expect(escalationResult(s, 2).undeclaredKillers).toEqual(['a.test.mjs::x']); // 2 of 2
  });

  it('never attributes when a run was not a genuine kill: a timeout or a load error proves nothing about the fault', () => {
    const timedOut = fold(
      { run: kill(), failedTests: ['a.test.mjs::x'] },
      { run: run('timeout'), failedTests: ['a.test.mjs::x'] },
      { run: kill(), failedTests: ['a.test.mjs::x'] },
    );
    expect(escalationResult(timedOut, 3).undeclaredKillers).toBeUndefined();

    const errored = fold(
      { run: kill(), failedTests: ['a.test.mjs::x'] },
      { run: run('error'), failedTests: ['a.test.mjs::x'] },
      { run: kill(), failedTests: ['a.test.mjs::x'] },
    );
    expect(escalationResult(errored, 3).undeclaredKillers).toBeUndefined();

    // a failure with no assertion behind it is not a kill either
    const noAssertion = fold(
      { run: run('fail', 0), failedTests: ['a.test.mjs::x'] },
      { run: run('fail', 0), failedTests: ['a.test.mjs::x'] },
      { run: run('fail', 0), failedTests: ['a.test.mjs::x'] },
    );
    expect(escalationResult(noAssertion, 3).undeclaredKillers).toBeUndefined();
  });

  it('always reports the runs it made, attributed or not', () => {
    expect(escalationResult(fold({ run: kill(), failedTests: [] }), 3)).toMatchObject({ escalated: true, escalationRuns: [expect.objectContaining({ outcome: 'fail' })] });
  });
});

describe('flake rate — only runs that actually ran carry information', () => {
  it('counts pass and fail, and reports the failures among them', () => {
    expect(flakeRate([run('pass'), run('fail', 1), run('pass')])).toEqual({ runs: 3, failures: 1 });
  });

  it('excludes timeouts and load errors rather than counting them as failures', () => {
    expect(flakeRate([run('pass'), run('timeout'), run('error'), run('fail', 1)])).toEqual({ runs: 2, failures: 1 });
  });

  it('is undefined when nothing was measurable, so the field is omitted rather than reported as zero', () => {
    expect(flakeRate([run('timeout'), run('error')])).toBeUndefined();
    expect(flakeRate([])).toBeUndefined();
  });
});

describe('killersFromRuns', () => {
  it('reduces failing test ids to distinct files', () => {
    expect(killersFromRuns([
      { failedTests: ['a.test.mjs::one', 'a.test.mjs::two'] },
      { failedTests: ['b.test.mjs::three'] },
      {},
    ])).toEqual(['a.test.mjs', 'b.test.mjs']);
  });
});

describe('the subject record makes a fault edit visible', () => {
  const fault = { id: 'F1', description: 'd', file: 'src/x.mjs', faultClass: 'other', producedBy: { producer: 'human' }, find: 'a', replace: 'b' };

  it('records a content hash derived from find and replace', () => {
    const s = subjectOf(fault, sha256);
    expect(s.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(s.contentHash).toBe(sha256('a\nb'));
    expect(s).toMatchObject({ kind: 'fault', id: 'F1', file: 'src/x.mjs' });
  });

  it('changes when the fault is weakened — the whole point, since a weakened fault is the cheap way to make a survivor vanish', () => {
    const before = subjectOf(fault, sha256).contentHash;
    const after = subjectOf({ ...fault, replace: 'b // weakened' }, sha256).contentHash;
    expect(after).not.toBe(before);
  });

  it('distinguishes a changed find from a changed replace rather than hashing them together ambiguously', () => {
    const a = subjectOf({ ...fault, find: 'a\nb', replace: '' }, sha256).contentHash;
    const b = subjectOf({ ...fault, find: 'a', replace: 'b' }, sha256).contentHash;
    expect(a).not.toBe(b);
  });
});

describe('reuse — a prior verdict may only stand for the fault that produced it', () => {
  const fault = { id: 'F1', description: 'd', file: 'src/a.mjs', faultClass: 'guard-removed', producedBy: { producer: 'human' }, find: 'if (ok) {', replace: 'if (true) {' };
  const current = () => ({
    inputs: { targetHash: 'T', defenderHashes: { 'a.test.mjs': 'D' } },
    requested: ['a.test.mjs'],
    resolved: ['a.test.mjs'],
    contentHash: subjectOf(fault, sha256).contentHash,
  });
  const prior = (over = {}) => ({
    inputs: { targetHash: 'T', defenderHashes: { 'a.test.mjs': 'D' } },
    defenders: { requested: ['a.test.mjs'], resolved: ['a.test.mjs'] },
    subject: subjectOf(fault, sha256),
    ...over,
  });

  it('reuses when the source, the defenders and the fault are all unchanged', () => {
    expect(isReusable(prior(), current())).toBe(true);
  });

  it('never reuses across an edited fault — the verdict was measured against a fault that no longer exists', () => {
    // The whole premise is that a fault edit cannot be invisible. Weakening a
    // `replace` after a fault survived, or repairing a rotted anchor, changes
    // what is being asked; the old answer is not an answer to the new question.
    const weakened = { ...fault, replace: 'if (ok) { /* no-op */' };
    const repaired = { ...fault, find: 'if (ok) {   // moved' };
    expect(isReusable(prior(), { ...current(), contentHash: subjectOf(weakened, sha256).contentHash })).toBe(false);
    expect(isReusable(prior(), { ...current(), contentHash: subjectOf(repaired, sha256).contentHash })).toBe(false);
  });

  it('re-probes rather than reuses when a prior record predates contentHash', () => {
    const old = prior();
    delete old.subject.contentHash;
    expect(isReusable(old, current())).toBe(false);
  });

  it('re-probes a prior with no subject at all, instead of throwing on it', () => {
    // Evidence from a non-TestGuard adopter of the spec, or from before the
    // subject was recorded, must degrade to "measure it again" — never to a
    // crash, and never to a reuse that was never compared.
    const headless = prior();
    delete headless.subject;
    expect(() => isReusable(headless, current())).not.toThrow();
    expect(isReusable(headless, current())).toBe(false);
  });

  it('still refuses reuse when the source, a defender or the defender set changed', () => {
    expect(isReusable(prior({ inputs: { targetHash: 'OTHER', defenderHashes: { 'a.test.mjs': 'D' } } }), current())).toBe(false);
    expect(isReusable(prior({ inputs: { targetHash: 'T', defenderHashes: { 'a.test.mjs': 'CHANGED' } } }), current())).toBe(false);
    expect(isReusable(prior({ defenders: { requested: [], resolved: ['a.test.mjs'] } }), current())).toBe(false);
    expect(isReusable(prior({ defenders: { requested: ['a.test.mjs'], resolved: ['a.test.mjs', 'b.test.mjs'] } }), current())).toBe(false);
  });

  it('never reuses a record that exists because the probe threw', () => {
    // `probe-error` is a statement about the run, not about the code: the tree
    // was being deleted underneath it, a runner vanished, something threw. Its
    // inputs can match perfectly and it still has to be measured again, or one
    // disturbed run becomes a permanent verdict nobody took.
    const thrown = prior({ verdict: 'unverifiable', detail: { baselineRuns: [], probeRuns: [], reason: 'probe-error', message: 'ENOENT' } });
    expect(isReusable(thrown, current())).toBe(false);
    // Every other unverifiable reason is a property of the fault and reuses normally.
    expect(isReusable(prior({ verdict: 'unverifiable', detail: { baselineRuns: [], probeRuns: [], reason: 'anchor-missing' } }), current())).toBe(true);
  });

  it('has nothing to reuse without a prior', () => {
    expect(isReusable(undefined, current())).toBe(false);
  });
});
