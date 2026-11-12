// GATE-SEMANTICS "The checks run in a fixed order" (#265): nocover precedes an
// invalid anchor. A fault with no defender is reported nocover even when its
// anchor does not hit once, so a record that reports the anchor instead
// describes a run that cannot have happened.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';

const load = (dir, name) => JSON.parse(readFileSync(new URL(`./${dir}/${name}`, import.meta.url), 'utf8'));

describe('verdict order: nocover before an invalid anchor', () => {
  it('admits an anchor reason on a fault that has defenders', () => {
    const doc = load('examples', 'evidence.json');
    expect(doc.records[2]).toMatchObject({ verdict: 'unverifiable', detail: { reason: 'anchor-missing' }, defenders: { nocover: false } });
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('rejects an anchor reason on a fault with no defender', () => {
    const { errors } = validate('evidence', load('invalid', 'evidence.invalid-anchor-reported-over-nocover.json'));
    expect(errors).toEqual([expect.objectContaining({ path: '/records/2/verdict', message: expect.stringMatching(/nocover precedes an invalid anchor/) })]);
  });

  it.each(['anchor-missing', 'anchor-ambiguous'])('rejects %s reported for a fault whose defenders resolved to nothing', (reason) => {
    const doc = load('examples', 'evidence.json');
    doc.records[2].defenders = { requested: ['test/none-*.test.mjs'], resolved: [], nocover: false };
    doc.records[2].detail.reason = reason;
    expect(validate('evidence', doc).errors.map((e) => e.path)).toContain('/records/2/verdict');
  });
});
