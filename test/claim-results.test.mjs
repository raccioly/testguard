// Issue #234: the per-claim result block of `probe --json`. Pure; every branch
// of the rule in GATE-SEMANTICS.md ("Per-claim results") has its own case.
import { describe, expect, it } from 'vitest';
import { claimResult, claimResults, VERDICT_COUNTERS } from '../src/probe/claim-results.mjs';
import { thinClaims, renderThin } from '../src/claims/thin.mjs';
import { runErrors, resultOf } from '../spec/lib/run-result.mjs';

const record = (claim, fault, verdict, reason) => ({ claim: { id: claim }, subject: { id: fault }, verdict, ...(reason ? { detail: { reason } } : { detail: {} }) });
const counts = (over = {}) => ({ total: 0, killed: 0, survived: 0, nocover: 0, unverifiable: 0, faultInvalid: 0, timeout: 0, flakyDefender: 0, ...over });

describe('claimResult: the rule, in the order GATE-SEMANTICS.md states it', () => {
  it('is proven only when at least one fault was measured and every one was killed', () => {
    expect(claimResult(counts({ total: 3, killed: 3 }))).toBe('proven');
  });
  it('is could-not-verify, never proven, when no fault was measured (an empty set is not a vacuous proof)', () => {
    expect(claimResult(counts())).toBe('could-not-verify');
  });
  it('is unproven when a fault survived, even if every other fault was killed', () => {
    expect(claimResult(counts({ total: 3, killed: 2, survived: 1 }))).toBe('unproven');
  });
  it('is unproven when a fault had no defender', () => {
    expect(claimResult(counts({ total: 2, killed: 1, nocover: 1 }))).toBe('unproven');
  });
  it.each(['unverifiable', 'faultInvalid', 'timeout', 'flakyDefender'])('is could-not-verify when the only blocker is %s: the measurement did not happen', (key) => {
    expect(claimResult(counts({ total: 2, killed: 1, [key]: 1 }))).toBe('could-not-verify');
  });
  it.each(['unverifiable', 'faultInvalid', 'timeout', 'flakyDefender'])('lets a survivor outrank %s: round toward unproven', (key) => {
    expect(claimResult(counts({ total: 3, killed: 1, survived: 1, [key]: 1 }))).toBe('unproven');
  });
});

describe('claimResults: counts and reasons from records, keyed by id', () => {
  const records = [
    record('A', 'F1', 'killed'), record('A', 'F2', 'killed'),
    record('B', 'F1', 'killed'), record('B', 'F2', 'survived'), record('B', 'F3', 'timeout', 'budget'),
    record('C', 'F1', 'unverifiable', 'anchor-missing'),
    record('D', 'F1', 'fault-invalid'), record('D', 'F2', 'flaky-defender'), record('D', 'F3', 'nocover'),
  ];
  const results = claimResults(records);
  it('keeps claims in the order they were probed and names each by id', () => {
    expect(results.map((r) => r.id)).toEqual(['A', 'B', 'C', 'D']);
  });
  it('proves a claim whose faults all died, with nothing to explain', () => {
    expect(results[0]).toEqual({ id: 'A', result: 'proven', faults: counts({ total: 2, killed: 2 }), reasons: [] });
  });
  it('lists one reason per fault that was not killed, by fault id, with the recorded reason when there is one', () => {
    expect(results[1].result).toBe('unproven');
    expect(results[1].faults).toEqual(counts({ total: 3, killed: 1, survived: 1, timeout: 1 }));
    expect(results[1].reasons).toEqual([{ faultId: 'F2', verdict: 'survived' }, { faultId: 'F3', verdict: 'timeout', reason: 'budget' }]);
  });
  it('counts every verdict into its own counter', () => {
    expect(results[2]).toMatchObject({ result: 'could-not-verify', faults: counts({ total: 1, unverifiable: 1 }) });
    expect(results[3].faults).toEqual(counts({ total: 3, faultInvalid: 1, flakyDefender: 1, nocover: 1 }));
    expect(results[3].result).toBe('unproven');
  });
  it('maps every verdict of the closed set to a counter', () => {
    expect(Object.keys(VERDICT_COUNTERS).sort()).toEqual(['fault-invalid', 'flaky-defender', 'killed', 'nocover', 'survived', 'timeout', 'unverifiable']);
  });
  it('never lets a verdict outside the closed set read as a kill', () => {
    const [r] = claimResults([record('X', 'F1', 'killed'), record('X', 'F2', 'mystery')]);
    expect(r.faults).toMatchObject({ total: 2, killed: 1 });
    expect(r.result).toBe('could-not-verify');
    expect(r.reasons).toEqual([{ faultId: 'F2', verdict: 'mystery' }]);
  });
  it('is empty for no records', () => {
    expect(claimResults([])).toEqual([]);
  });
  it('agrees with the validator\'s independent derivation on every result it produces', () => {
    for (const r of results) expect(resultOf(r.faults)).toBe(r.result);
  });
});

describe('the validator rejects a claim result its counts do not support', () => {
  const run = (claims, scope = { probedClaims: claims.map((c) => c.id), probedCount: claims.length, requestedClaims: claims.map((c) => c.id), requestedCount: claims.length }) => ({ id: 'run-1', evidence: 'e.json', provisional: false, records: 1, newSinceBaseline: 0, exitCode: 0, claims, scope });
  const proven = { id: 'A', result: 'proven', faults: counts({ total: 1, killed: 1 }), reasons: [] };
  it('accepts an honest block', () => expect(runErrors(run([proven]))).toEqual([]));
  it('rejects proven over a survivor', () => {
    const bad = { id: 'A', result: 'proven', faults: counts({ total: 2, killed: 1, survived: 1 }), reasons: [{ faultId: 'F2', verdict: 'survived' }] };
    expect(runErrors(run([bad])).map((e) => e.path)).toContain('/run/claims/0/result');
  });
  it('rejects proven over zero faults', () => {
    expect(runErrors(run([{ ...proven, faults: counts() }])).map((e) => e.path)).toContain('/run/claims/0/result');
  });
  it('rejects a total that is not the sum of the counts', () => {
    expect(runErrors(run([{ ...proven, faults: counts({ total: 2, killed: 1 }) }])).map((e) => e.path)).toContain('/run/claims/0/faults/total');
  });
  it('rejects a missing, duplicated or killed reason', () => {
    const missing = { id: 'A', result: 'unproven', faults: counts({ total: 1, survived: 1 }), reasons: [] };
    expect(runErrors(run([missing])).some((e) => /every fault that was not killed/.test(e.message))).toBe(true);
    const twice = { id: 'A', result: 'unproven', faults: counts({ total: 2, survived: 2 }), reasons: [{ faultId: 'F1', verdict: 'survived' }, { faultId: 'F1', verdict: 'survived' }] };
    expect(runErrors(run([twice])).some((e) => /listed twice/.test(e.message))).toBe(true);
    const killed = { ...proven, reasons: [{ faultId: 'F1', verdict: 'killed' }] };
    expect(runErrors(run([killed])).some((e) => /killed fault has no reason/.test(e.message))).toBe(true);
  });
  it('rejects a claim named twice and a block that is not the probed set', () => {
    expect(runErrors(run([proven, proven], { probedClaims: ['A', 'A'], probedCount: 2, requestedClaims: ['A'], requestedCount: 1 })).some((e) => /appears twice/.test(e.message))).toBe(true);
    expect(runErrors(run([proven], { probedClaims: ['B'], probedCount: 1, requestedClaims: ['B'], requestedCount: 1 })).map((e) => e.path)).toContain('/run/claims');
  });
});

describe('claim-thin: advisory, from the claim alone', () => {
  const fault = (id, faultClass) => ({ id, faultClass });
  it('flags a claim with a single fault', () => {
    expect(thinClaims([{ id: 'A', faults: [fault('F1', 'guard-removed')] }])).toEqual([{ claimId: 'A', signal: 'claim-thin', reason: 'fewer-than-two-faults', faults: 1, faultClasses: ['guard-removed'] }]);
  });
  it('flags a claim with two faults of one class', () => {
    expect(thinClaims([{ id: 'A', faults: [fault('F1', 'other'), fault('F2', 'other')] }])).toEqual([{ claimId: 'A', signal: 'claim-thin', reason: 'single-fault-class', faults: 2, faultClasses: ['other'] }]);
  });
  it('does not flag two faults of two classes', () => {
    expect(thinClaims([{ id: 'A', faults: [fault('F1', 'other'), fault('F2', 'guard-removed')] }])).toEqual([]);
  });
  it('renders nothing for no thin claim and a bounded line for many', () => {
    expect(renderThin([])).toEqual([]);
    const many = Array.from({ length: 7 }, (_, i) => ({ claimId: `C${i}`, signal: 'claim-thin', reason: 'fewer-than-two-faults', faults: 1, faultClasses: ['other'] }));
    const [line] = renderThin(many);
    expect(line).toMatch(/7 claims are thin/);
    expect(line).toMatch(/C4 \(1 fault\), …/);
    expect(line).not.toMatch(/C5/);
    expect(renderThin([{ claimId: 'Z', signal: 'claim-thin', reason: 'single-fault-class', faults: 2, faultClasses: ['other'] }])[0]).toMatch(/1 claim is thin \(claim-thin\): Z \(all other\)/);
  });
});
