// @req FR-09
// #331: a claim whose file is in a language TestGuard cannot read imports in is
// not "uncovered by tests": discovery cannot look. The record says so.
import { describe, it, expect } from 'vitest';
import { unsupportedDiscovery } from '../src/probe/discover.mjs';
import { renderRecord } from '../src/render.mjs';

const record = (detail, extra = {}) => ({
  verdict: 'nocover',
  claim: { id: 'C-1', severity: 'high' },
  subject: { id: 'F1' },
  detail: { baselineRuns: [], probeRuns: [], ...detail },
  defenders: { discovered: true, nocover: true, resolved: [], requested: [] },
  ...extra,
});

describe('unsupportedDiscovery — a target in a language with no import reader', () => {
  it('names the language and tells the author to declare defendedBy', () => {
    expect(unsupportedDiscovery('src/main/java/demo/Discount.java')).toEqual({
      reason: 'defender-discovery-unsupported',
      message: 'defender-discovery-unsupported (java): declare defendedBy',
    });
    expect(unsupportedDiscovery('force-app/main/default/classes/DiscountService.cls').message).toBe('defender-discovery-unsupported (apex): declare defendedBy');
  });

  it('is null for a language discovery reads, and for an unknown one', () => {
    expect(unsupportedDiscovery('src/a.mjs')).toBeNull();
    expect(unsupportedDiscovery('src/a.ts')).toBeNull();
    expect(unsupportedDiscovery('pkg/a.py')).toBeNull();
    expect(unsupportedDiscovery('notes/readme.txt')).toBeNull();
  });
});

describe('renderRecord — the NOCOVER line for an unsupported language', () => {
  it('prints the unsupported reason and does not claim the defenders were discovered by import', () => {
    const line = renderRecord(record({ reason: 'defender-discovery-unsupported', message: 'defender-discovery-unsupported (java): declare defendedBy' }));
    expect(line).toContain('[defender-discovery-unsupported (java): declare defendedBy]');
    expect(line).not.toContain('discovered by import');
  });

  it('keeps the old wording for an ordinary NOCOVER', () => {
    expect(renderRecord(record({}))).toContain('(defenders discovered by import)');
  });
});

describe('the evidence record', () => {
  it('stays a conformant evidence document with the new reason', async () => {
    const { validate } = await import('../spec/lib/validate.mjs');
    const { readFileSync } = await import('node:fs');
    const doc = JSON.parse(readFileSync(new URL('./fixtures/unsupported-nocover-evidence.json', import.meta.url), 'utf8'));
    expect(validate('evidence', doc)).toMatchObject({ ok: true, errors: [] });
    expect(doc.records[0].detail.reason).toBe('defender-discovery-unsupported');
  });
});
