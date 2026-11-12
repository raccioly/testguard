// #305: the Playwright gallery's reference runs in its own CI job and the modes that only compare hand their
// answers to the scorecard. The merge must be exactly as strict as the in-shard comparison was.
import { describe, it, expect } from 'vitest';
import { completeness, resolveDeferred } from '../corpus/lib/deferred.mjs';
import { mergeScorecards } from '../corpus/lib/scorecard.mjs';
import { applies, MODES, sliceOf } from '../corpus/lib/modes.mjs';

const ORDER = ['A/F1', 'A/F2', 'B/F1', 'B/F2'];
const map = (over = {}) => Object.fromEntries(ORDER.map((id) => [id, { verdict: 'killed', killKind: 'assertion', ...(over[id] ?? {}) }]));
const base = { error: null, faults: null, mismatches: [], differential: null, checks: [], runs: [{ label: 'x', elapsedMs: 1000 }], runnerInvocations: null, seconds: 1, normalizedSeconds: null, speedup: null, noEvidence: [] };
const reference = (extra = {}) => ({ ...base, subject: 's', mode: 'reference', ok: true, runs: [{ label: 'reference', elapsedMs: 4000 }], observed: { subject: 's', faultCount: 4, order: ORDER, map: map(), ...extra } });
const mode = (name, pending, extra = {}) => ({ ...base, subject: 's', mode: name, ok: true, pending, ...extra });
const answers = (over) => ({ observed: { order: ORDER, map: map(over) }, faultCount: 4 });
const doc = (rows, head = 'abc') => ({ schemaVersion: 1, tool: { version: '0', head }, machine: { before: { workload: 'w', medianMs: 1, samplesMs: [1] }, after: { workload: 'w', medianMs: 1, samplesMs: [1] }, speedFactor: null }, ok: true, totals: {}, rows });
const failed = (rows, check) => rows.filter((r) => !r.ok && r.checks.some((c) => c.check === check));

describe('deferred comparisons against the reference artifact', () => {
  it('an equal answer passes, with the speedup computed from the reference run; pending and observed are consumed', () => {
    const rows = resolveDeferred([reference(), mode('default', [answers()])]);
    const m = rows.find((r) => r.mode === 'default');
    expect(m).toMatchObject({ ok: true, differential: { equal: true, compared: 4, orderEqual: true }, speedup: 4 });
    for (const r of rows) { expect(r.pending).toBeUndefined(); expect(r.observed).toBeUndefined(); }
  });

  it('a different verdict is a differential mismatch, exactly as in-shard', () => {
    const m = resolveDeferred([reference(), mode('default', [answers({ 'A/F2': { verdict: 'survived', killKind: undefined } })])]).find((r) => r.mode === 'default');
    expect(m.ok).toBe(false);
    expect(m.differential).toMatchObject({ equal: false });
    expect(m.differential.mismatches.map((x) => x.fault)).toEqual(['A/F2']);
  });

  it('reorder compares against the reference answers in the order it ran', () => {
    const rev = [...ORDER].reverse();
    const pending = [{ observed: { order: rev, map: map() }, referenceOrder: rev, faultCount: 4 }];
    expect(resolveDeferred([reference(), mode('reorder', pending)]).find((r) => r.mode === 'reorder').ok).toBe(true);
    const wrong = [{ observed: { order: ORDER, map: map() }, referenceOrder: rev, faultCount: 4 }];
    expect(resolveDeferred([reference(), mode('reorder', wrong)]).find((r) => r.mode === 'reorder').differential.orderEqual).toBe(false);
  });

  it('a missing reference is a failure, never a skipped comparison', () => {
    const rows = resolveDeferred([mode('default', [answers()])]);
    expect(failed(rows, 'differential-reference-present')).toHaveLength(1);
  });

  it('a partial reference, or one of another subject, is refused', () => {
    expect(failed(resolveDeferred([reference({ order: ORDER.slice(0, 2) }), mode('default', [answers()])]), 'differential-reference-complete')).toHaveLength(1);
    expect(failed(resolveDeferred([reference({ faultCount: 5 }), mode('default', [answers()])]), 'differential-reference-complete')).toHaveLength(1);
    expect(failed(resolveDeferred([reference({ subject: 'other' }), mode('default', [answers()])]), 'differential-reference-complete')).toHaveLength(1);
  });

  it('a reference measured by another tool commit is refused when the shards are merged', () => {
    expect(() => mergeScorecards([doc([reference()], 'aaa'), doc([mode('default', [answers()])], 'bbb')])).toThrow(/different builds/);
  });
});

describe('sliced modes', () => {
  const slice = (index, faults) => mode('twice', [{ observed: { order: faults, map: map() }, ids: faults, faultCount: 4 }], { slice: { index, of: 2, faults } });
  it('two slices that together cover every fault once pass', () => {
    const rows = resolveDeferred([reference(), slice(1, ['A/F1', 'A/F2']), slice(2, ['B/F1', 'B/F2'])]);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
  it('a missing slice, an overlap and an unknown fault each fail', () => {
    expect(failed(resolveDeferred([reference(), slice(1, ['A/F1', 'A/F2'])]), 'slices-cover-every-fault-exactly-once')).toHaveLength(1);
    expect(failed(resolveDeferred([reference(), slice(1, ['A/F1', 'A/F2']), slice(2, ['A/F2', 'B/F1', 'B/F2'])]), 'slices-cover-every-fault-exactly-once')).toHaveLength(1);
    expect(failed(resolveDeferred([reference(), slice(1, ['A/F1', 'A/F2']), slice(2, ['B/F1', 'B/F2', 'Z/F1'])]), 'slices-cover-every-fault-exactly-once')).toHaveLength(1);
  });
  it('slices partition the claims and every fault lands in exactly one', () => {
    const subject = { faultIds: ORDER };
    const a = sliceOf(subject, 1, 2);
    const b = sliceOf(subject, 2, 2);
    expect([...a.ids, ...b.ids].sort()).toEqual(ORDER);
    expect(a.claims).toEqual(['A']);
  });
});

describe('every mode that applies has a shard; the rest are recorded as not applicable, from applies()', () => {
  const subject = { name: 's', config: {}, key: {} }; // no typecheck, no changed key, no noise
  it('a missing applicable mode fails; an inapplicable one is recorded, not failed', () => {
    const present = MODES.filter((m) => applies(m, subject));
    const rows = present.filter((m) => m !== 'scratch').map((m) => ({ ...base, subject: 's', mode: m, ok: true }));
    const out = completeness(rows, [subject]);
    expect(failed(out, 'mode-has-a-shard').map((r) => r.mode)).toEqual(['scratch']);
    const na = out.filter((r) => r.checks.some((c) => c.check === 'not-applicable')).map((r) => r.mode).sort();
    expect(na).toEqual(MODES.filter((m) => !applies(m, subject)).sort());
    expect(na).toEqual(['changed', 'noise', 'typecheck']);
    expect(out.filter((r) => r.checks.some((c) => c.check === 'not-applicable')).every((r) => r.ok)).toBe(true);
  });
});
