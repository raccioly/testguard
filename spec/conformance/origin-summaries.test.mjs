import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';
import { fingerprint } from '../lib/fingerprint.mjs';
import { declaredOriginSummary, recordedOriginSummary } from '../lib/origins.mjs';

const example = (kind) => JSON.parse(readFileSync(new URL(`./examples/${kind}.json`, import.meta.url), 'utf8'));
function withOrigins(kind) {
  const doc = example(kind);
  if (kind === 'evidence') doc.origins = recordedOriginSummary(doc.records);
  else if (kind === 'status') doc.origins = declaredOriginSummary(Array.from({ length: doc.counts.claims }, (_, i) => ({ id: `C-${i}`, source: { kind: 'spec' } })));
  else {
    const records = Array.from({ length: Object.values(doc.summary.byVerdict).reduce((a, b) => a + b, 0) }, (_, i) => ({ claim: { id: `C-${i % doc.summary.claims}`, source: { kind: 'spec' } } }));
    doc.origins = recordedOriginSummary(records);
  }
  return doc;
}

describe('optional origin summaries — closed, arithmetically bound, not authentication', () => {
  for (const kind of ['evidence', 'status', 'brief']) {
    it(`${kind} retains legacy reads and accepts its summary without mutation`, () => {
      expect(validate(kind, example(kind)).errors).toEqual([]);
      const doc = withOrigins(kind), before = JSON.stringify(doc);
      expect(validate(kind, doc).errors).toEqual([]);
      expect(JSON.stringify(doc)).toBe(before);
    });
    it.each(['unknown-key', 'missing-key', 'fraction', 'negative', 'unsafe', 'extra', 'claim-sum', 'basis', 'records']) (`${kind} refuses invalid summary %s`, (fault) => {
      const doc = withOrigins(kind), o = doc.origins;
      if (fault === 'unknown-key') o.claims.byKind.authenticated = 0;
      if (fault === 'missing-key') delete o.claims.byKind.inferred;
      if (fault === 'fraction') o.claims.total = 0.5;
      if (fault === 'negative') o.claims.mixed = -1;
      if (fault === 'unsafe') o.claims.total = Number.MAX_SAFE_INTEGER + 1;
      if (fault === 'extra') o.authenticated = true;
      if (fault === 'claim-sum') o.claims.total++;
      if (fault === 'basis') o.basis = kind === 'status' ? 'recorded' : 'declared';
      if (fault === 'records') { if (kind === 'status') o.records = { total: 0, byKind: { ...o.claims.byKind } }; else delete o.records; }
      expect(validate(kind, doc).ok).toBe(false);
    });
    it(`${kind} rejects internally plausible totals that disagree with its document`, () => {
      const doc = withOrigins(kind);
      doc.origins.claims.total++; doc.origins.claims.byKind.spec++;
      expect(validate(kind, doc).ok).toBe(false);
    });
  }
  it('evidence rejects an arithmetically correct invented kind split', () => {
    const doc = withOrigins('evidence');
    const old = Object.keys(doc.origins.claims.byKind).find((k) => doc.origins.claims.byKind[k] > 0);
    doc.origins.claims.byKind[old]--; doc.origins.claims.byKind.incident++;
    expect(validate('evidence', doc).ok).toBe(false);
  });
  it('evidence accepts mixed references and rejects relabeling them as consistent', () => {
    const doc = example('evidence'), r = structuredClone(doc.records[0]);
    r.subject.id = 'MIXED-REFERENCE'; r.claim.source.ref = 'different-declaration';
    r.fingerprint = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file ?? '', verdict: r.verdict });
    doc.records.push(r); doc.origins = recordedOriginSummary(doc.records);
    expect(doc.origins.claims.mixed).toBe(1);
    expect(validate('evidence', doc).errors).toEqual([]);
    doc.origins.claims.mixed--; doc.origins.claims.byKind[r.claim.source.kind]++;
    expect(validate('evidence', doc).ok).toBe(false);
  });
  it.each(['evidence', 'brief'])('%s rejects internally plausible but wrong record totals', (kind) => {
    const doc = withOrigins(kind);
    doc.origins.records.total++; doc.origins.records.byKind.spec++;
    expect(validate(kind, doc).ok).toBe(false);
  });
  it.each(['status', 'brief'])('%s checks claim bucket arithmetic independently of the document total', (kind) => {
    const doc = withOrigins(kind);
    doc.origins.claims.byKind.spec++;
    expect(validate(kind, doc).ok).toBe(false);
  });
  it('declared status cannot invent mixed identities', () => {
    const doc = withOrigins('status');
    doc.origins.claims.byKind.spec--; doc.origins.claims.mixed++;
    expect(validate('status', doc).ok).toBe(false);
  });
});
