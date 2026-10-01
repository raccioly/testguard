import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';
import { rank } from '../../src/probe/rank.mjs';
import { fileURLToPath } from 'node:url';
import { scaffoldFile } from '../../src/scaffold/scaffold.mjs';
import { poolDrafts } from '../../src/sweep/pool.mjs';

const kinds = ['spec', 'adr', 'annotation', 'comment', 'manual', 'doc', 'bug', 'incident', 'review', 'inferred'];
const example = (kind) => JSON.parse(readFileSync(new URL(`./examples/${kind}.json`, import.meta.url), 'utf8'));
const sourceOf = (kind, doc) => kind === 'claims' ? doc.claims[0].source : doc.records[0].claim.source;

describe('declared claim origins — vocabulary, not authenticated independence', () => {
  it('keeps colliding pooled claims conforming without promoting their declared origins', () => {
    const source = example('claims');
    const pooled = poolDrafts([source, structuredClone(source)]);
    expect(validate('claims', { schemaVersion: 1, claims: pooled.flatMap((d) => d.claims) }).errors).toEqual([]);
    expect(pooled[1].claims.map((c) => c.source)).toEqual(source.claims.map((c) => c.source));
    expect(pooled[1].claims.map((c) => c.faults)).toEqual(source.claims.map((c) => c.faults));
  });
  it('admits real mechanically inferred drafts without requiring or authenticating intent', () => {
    const projectDir = fileURLToPath(new URL('../../fixtures/known-answer/', import.meta.url));
    const { doc } = scaffoldFile({ projectDir, file: 'src/redact.mjs' });
    expect(doc.claims.length).toBeGreaterThan(0);
    expect(validate('claims', doc).errors).toEqual([]);
    for (const claim of doc.claims) {
      expect(claim.source.kind).toBe('inferred');
      expect(claim.producedBy.producer).toBe('derived');
      expect(claim.statement).toContain('intended observable behavior');
    }
  });
  for (const format of ['claims', 'evidence']) {
    it.each(kinds)(`${format} accepts the declared %s origin without changing observations`, (kind) => {
      const doc = example(format);
      const source = sourceOf(format, doc);
      source.kind = kind;
      source.ref = 'opaque-reference:not-fetched';
      const before = JSON.stringify(doc);
      expect(validate(format, doc).errors).toEqual([]);
      expect(JSON.stringify(doc)).toBe(before);
    });

    it.each(['unknown', '', 42, null])(`${format} rejects unsupported source kind %s`, (kind) => {
      const doc = example(format); sourceOf(format, doc).kind = kind;
      expect(validate(format, doc).ok).toBe(false);
    });

    it(`${format} retains required kind, opaque ref limits and closed source objects`, () => {
      const doc = example(format); const source = sourceOf(format, doc);
      delete source.kind;
      expect(validate(format, doc).ok).toBe(false);
      source.kind = 'incident'; source.ref = 'x'.repeat(512);
      expect(validate(format, doc).ok).toBe(true);
      source.ref += 'x';
      expect(validate(format, doc).ok).toBe(false);
      delete source.ref; source.authenticated = true;
      expect(validate(format, doc).ok).toBe(false);
    });
  }

  it('preserves existing rank weights and uses the existing fallback for new declarations', () => {
    const score = (sourceKind) => rank({ severity: 'low', sourceKind, blast: 0, independence: 'separate-change' }).score;
    expect(kinds.slice(0, 5).map(score)).toEqual([1, 1, 0.75, 0.75, 0.9]);
    expect(kinds.slice(5).map(score)).toEqual([0.9, 0.9, 0.9, 0.9, 0.9]);
  });
});
