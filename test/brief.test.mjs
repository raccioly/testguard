import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildBrief, HEADING, hintFor } from '../src/brief/brief.mjs';
import { buildBaseline } from '../src/baseline/baseline.mjs';
import { validate } from '../spec/lib/validate.mjs';

const evidence = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));

describe('buildBrief', () => {
  it('conforms to the spec with and without a baseline', () => {
    expect(validate('brief', buildBrief(evidence, undefined)).errors).toEqual([]);
    expect(validate('brief', buildBrief(evidence, buildBaseline(evidence))).errors).toEqual([]);
  });
  it('text opens with the heading and names the items', () => {
    const b = buildBrief(evidence, undefined);
    expect(b.text.startsWith(HEADING)).toBe(true);
    expect(b.text).toContain('[NEW] SURVIVED  REDACT-001/F1');
  });
  it('puts new findings before baselined ones, survivors first', () => {
    const partial = { fingerprints: { [evidence.records[0].fingerprint]: 1 } }; // baseline only the survivor
    const b = buildBrief(evidence, partial);
    expect(b.items[0].isNew).toBe(true);
    expect(b.items[b.items.length - 1]).toMatchObject({ isNew: false, verdict: 'survived' });
    expect(b.summary.baselined).toBe(1);
  });
  it('caps at max and says how many more there are', () => {
    const b = buildBrief(evidence, undefined, { max: 1 });
    expect(b.items).toHaveLength(1);
    expect(b.text).toMatch(/and \d+ more in the evidence file/);
  });
  it('says so when everything is defended', () => {
    const allKilled = { ...evidence, records: evidence.records.filter((r) => r.verdict === 'killed') };
    const b = buildBrief(allKilled, undefined);
    expect(b.items).toEqual([]);
    expect(b.text).toContain('Every probed claim is defended');
    expect(validate('brief', b).ok).toBe(true);
  });
  it('hints name the mechanism, not just the verdict', () => {
    const byVerdict = Object.fromEntries(evidence.records.map((r) => [r.verdict, r]));
    expect(hintFor(byVerdict.survived)).toContain('stayed green');
    expect(hintFor(byVerdict.nocover)).toContain('No test file matches');
    expect(hintFor(byVerdict.unverifiable)).toContain('anchor-missing');
    expect(hintFor(byVerdict['flaky-defender'])).toContain('not reliably green');
  });
});
