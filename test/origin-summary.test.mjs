import { describe, expect, it } from 'vitest';
import { declaredOriginSummary, recordedOriginSummary, CLAIM_SOURCE_KINDS } from '../spec/lib/origins.mjs';

const claim = (id, kind, ref) => ({ id, source: { kind, ...(ref === undefined ? {} : { ref }) } });
const record = (id, kind, ref) => ({ claim: claim(id, kind, ref), verdict: 'killed' });
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

describe('origin summaries — declarations are not proof', () => {
  it('counts current claims once, not their faults, without mutating or leaking references', () => {
    const claims = [claim('A-1', 'incident', 'opaque-reference'), claim('B-1', 'comment')];
    claims[0].faults = [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }];
    const before = JSON.stringify(claims);
    const result = declaredOriginSummary(claims);
    expect(result).toMatchObject({ basis: 'declared', claims: { total: 2, mixed: 0, byKind: { incident: 1, comment: 1 } } });
    expect(total(result.claims.byKind)).toBe(2);
    expect(result).not.toHaveProperty('records');
    expect(JSON.stringify(result)).not.toContain('opaque-reference');
    expect(JSON.stringify(claims)).toBe(before);
  });

  it('counts one recorded claim and three actual records, regardless of verdict', () => {
    const records = [record('A-1', 'bug'), record('A-1', 'bug'), record('A-1', 'bug')];
    records[1].verdict = 'survived'; records[2].verdict = 'timeout';
    const result = recordedOriginSummary(records);
    expect(result).toMatchObject({ basis: 'recorded', claims: { total: 1, mixed: 0, byKind: { bug: 1 } }, records: { total: 3, byKind: { bug: 3 } } });
    expect(total(result.claims.byKind)).toBe(1);
    expect(total(result.records.byKind)).toBe(3);
  });

  it.each([
    [record('A-1', 'bug'), record('A-1', 'spec')],
    [record('A-1', 'spec', 'first'), record('A-1', 'spec', 'second')],
    [record('A-1', 'spec'), record('A-1', 'spec', '')],
  ])('reports conflicting declarations as mixed instead of choosing a label: %j', (...records) => {
    const result = recordedOriginSummary(records);
    expect(result.claims.total).toBe(1);
    expect(result.claims.mixed).toBe(1);
    expect(total(result.claims.byKind)).toBe(0);
    expect(total(result.records.byKind)).toBe(2);
    expect(recordedOriginSummary([...records].reverse())).toEqual(result);
  });

  it('ignores object-key order but not source/ref values, and keeps inputs unchanged', () => {
    const records = [record('A-1', 'review', 'r'), { claim: { id: 'A-1', source: { ref: 'r', kind: 'review' } } }];
    const before = JSON.stringify(records);
    expect(recordedOriginSummary(records).claims).toMatchObject({ total: 1, mixed: 0, byKind: { review: 1 } });
    expect(JSON.stringify(records)).toBe(before);
  });

  it('reports every declared kind and zero denominators without implying gate success', () => {
    expect(CLAIM_SOURCE_KINDS).toEqual(['spec', 'adr', 'annotation', 'comment', 'manual', 'doc', 'bug', 'incident', 'review', 'inferred']);
    const empty = recordedOriginSummary([]);
    expect(empty.claims.total).toBe(0); expect(empty.records.total).toBe(0);
    expect(Object.keys(empty.claims.byKind)).toEqual(CLAIM_SOURCE_KINDS);
    expect(total(empty.claims.byKind)).toBe(0);
    expect(empty).not.toHaveProperty('passed');
    const result = declaredOriginSummary(CLAIM_SOURCE_KINDS.map((kind, i) => claim(`A-${i}`, kind)));
    expect(Object.values(result.claims.byKind)).toEqual(Array(10).fill(1));
  });

  it('refuses duplicate current claim identities rather than hiding a contradictory declaration', () => {
    expect(() => declaredOriginSummary([claim('A-1', 'spec'), claim('A-1', 'comment')])).toThrow(/duplicate/i);
  });

  it.each([claim('A-1', '__proto__'), claim('', 'spec'), { id: 'A-1' }, claim('A-1', 'spec', 7)])('refuses malformed summary inputs: %j', (input) => {
    expect(() => declaredOriginSummary([input])).toThrow();
    expect(() => recordedOriginSummary([{ claim: input }])).toThrow();
  });
});
