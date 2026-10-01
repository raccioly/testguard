import { describe, it, expect } from 'vitest';
import { appendDraft } from '../src/scaffold/append.mjs';
import { validate } from '../spec/lib/validate.mjs';

const fault = (extra = {}) => ({ id: 'S1', description: 'Reject absent input.', file: 'src/a/guard.mjs', faultClass: 'condition-forced', find: 'if (!x)', replace: 'if (false)', producedBy: { producer: 'derived' }, ...extra });
const claim = (extra = {}) => ({ id: 'GUARD-001', statement: 'Absent input must be rejected.', source: { kind: 'incident', ref: 'opaque:incident-1' }, severity: 'critical', producedBy: { producer: 'human' }, defendedBy: ['test/guard.test.mjs'], tags: ['access'], faults: [fault()], ...extra });
const doc = (claims) => ({ schemaVersion: 1, claims });
const fixture = () => ({ draft: doc([claim(), claim({ id: 'OTHER-001' })]), proposals: doc([claim({ source: { kind: 'inferred' }, faults: [fault({ file: 'src/b/guard.mjs' })] })]), claimId: 'GUARD-001' });
const admittedAppend = (args) => {
  let result;
  expect(() => { result = appendDraft(args); }).not.toThrow();
  return result;
};

describe('draft append preserves supplied intent and injection identity', () => {
  it('appends across equal-basename files without replacing metadata, faults or sibling claims', () => {
    const args = fixture(); const before = JSON.stringify(args);
    const result = admittedAppend(args);
    expect(validate('claims', result).errors).toEqual([]);
    expect(result.claims[0]).toEqual({ ...args.draft.claims[0], faults: [...args.draft.claims[0].faults, { ...args.proposals.claims[0].faults[0], id: 'S2' }] });
    expect(result.claims[1]).toEqual(args.draft.claims[1]);
    expect(JSON.stringify(args)).toBe(before);
    result.claims[0].source.ref = 'changed'; result.claims[0].faults[1].producedBy.producer = 'agent';
    expect(JSON.stringify(args)).toBe(before);
  });

  it('deduplicates repeated proposals independent of proposed IDs/descriptions/producers', () => {
    const args = fixture();
    const f = args.proposals.claims[0].faults[0];
    args.proposals.claims[0].faults.push({ ...f, id: 'S99', description: 'Another description', producedBy: { producer: 'agent' } });
    const once = admittedAppend(args);
    expect(once.claims[0].faults).toHaveLength(2);
    expect(admittedAppend({ ...args, draft: once })).toEqual(once);
  });

  it('keeps existing equivalent defaults and allocates unused IDs across proposal groups', () => {
    const args = fixture();
    args.draft.claims[0].faults.push(fault({ id: 'S3', file: 'src/c/guard.mjs' }));
    args.proposals.claims[0].faults.push(fault({ id: 'S2', expectHits: 1, occurrence: 1 }));
    args.proposals.claims.push(claim({ id: 'PROPOSAL-002', faults: [fault({ file: 'src/d/guard.mjs' })] }));
    expect(admittedAppend(args).claims[0].faults.map((f) => f.id)).toEqual(['S1', 'S3', 'S2', 'S4']);
  });

  it('keeps distinct occurrence, replacement, class and fault defender selections', () => {
    const args = fixture();
    const f = fault({ expectHits: 2, occurrence: 1 });
    args.proposals.claims[0].faults = [f, { ...f, id: 'S2', occurrence: 2 }, { ...f, id: 'S3', replace: 'if (true)' }, { ...f, id: 'S4', faultClass: 'other' }, { ...f, id: 'S5', defendedBy: [] }, { ...f, id: 'S6', defendedBy: ['test/a.test.mjs', 'test/b.test.mjs'] }, { ...f, id: 'S7', defendedBy: ['test/b.test.mjs', 'test/a.test.mjs'] }];
    const result = admittedAppend(args);
    expect(result.claims[0].faults).toHaveLength(7);
    expect(result.claims[0].faults.at(-1).defendedBy).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it.each([{ claimId: undefined }, { claimId: '' }, { claimId: 'UNKNOWN-001' }, { claimId: ['GUARD-001'] }])('refuses selection $claimId without mutating inputs', ({ claimId }) => {
    const args = { ...fixture(), claimId }; const before = JSON.stringify(args);
    expect(() => appendDraft(args)).toThrow(); expect(JSON.stringify(args)).toBe(before);
  });

  it('refuses malformed inputs instead of returning a partial draft', () => {
    const args = fixture(); args.proposals.claims[0].faults[0].replace = args.proposals.claims[0].faults[0].find;
    expect(() => appendDraft(args)).toThrow(/proposals/);
    const invalid = fixture(); invalid.draft.claims[0].faults.push(invalid.draft.claims[0].faults[0]);
    expect(() => appendDraft(invalid)).toThrow(/draft/);
  });

  it('preserves reserved existing subjects but refuses new reserved-method proposals', () => {
    const args = fixture();
    const reserved = fault({ id: 'SCAN-001', method: 'scan', methodDetail: { query: 'guard' } });
    args.draft.claims[0].faults.push(reserved);
    expect(validate('claims', args.draft).errors).toEqual([]);
    expect(admittedAppend(args).claims[0].faults[1]).toEqual(reserved);
    args.proposals.claims[0].faults = [reserved];
    expect(validate('claims', args.proposals).errors).toEqual([]);
    const before = JSON.stringify(args);
    expect(() => appendDraft(args)).toThrow(/fault-injection/);
    expect(JSON.stringify(args)).toBe(before);
  });

  it('returns an owned no-op clone for an empty proposal document', () => {
    const args = fixture(); args.proposals = doc([]);
    const result = admittedAppend(args);
    expect(result).toEqual(args.draft);
    result.claims[0].faults[0].producedBy.producer = 'agent';
    expect(args.draft.claims[0].faults[0].producedBy.producer).toBe('derived');
  });
});
