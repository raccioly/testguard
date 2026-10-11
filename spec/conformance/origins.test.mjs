import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';
import { rank } from '../../src/probe/rank.mjs';
import { fileURLToPath } from 'node:url';
import { scaffoldFile } from '../../src/scaffold/scaffold.mjs';
import { poolDrafts } from '../../src/sweep/pool.mjs';
import { REQUIREMENT_REF_PATTERN, requirementRef } from '../lib/origins.mjs';

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

// The contract table in GATE-SEMANTICS.md "Declared claim origins": the schema
// and requirementRef() must accept exactly the same structured references.
describe('structured requirement references — req:<spec-id>#<requirement-id>', () => {
  const rows = [
    [{ kind: 'spec', ref: 'req:acme.billing#FR-003' }, true, { specId: 'acme.billing', requirementId: 'FR-003' }],
    [{ kind: 'spec', ref: 'req:Acme_Billing-2#NFR-01.2' }, true, { specId: 'Acme_Billing-2', requirementId: 'NFR-01.2' }],
    [{ kind: 'spec', ref: `req:${'a'.repeat(128)}#${'R'.repeat(64)}` }, true, { specId: 'a'.repeat(128), requirementId: 'R'.repeat(64) }],
    [{ kind: 'spec', ref: 'specs/001/spec.md#FR-003' }, true, null],
    [{ kind: 'spec', ref: 'requirement FR-003' }, true, null],
    [{ kind: 'spec' }, true, null],
    [{ kind: 'doc', ref: 'docs/spec.md#req:acme#FR-1' }, true, null],
    [{ kind: 'spec', ref: 'req:acme.billing' }, false, null],
    [{ kind: 'spec', ref: 'req:#FR-1' }, false, null],
    [{ kind: 'spec', ref: 'req:acme#' }, false, null],
    [{ kind: 'spec', ref: 'req:acme billing#FR-1' }, false, null],
    [{ kind: 'spec', ref: 'req:a/b#FR-1' }, false, null],
    [{ kind: 'spec', ref: 'req:acme#FR-1#x' }, false, null],
    [{ kind: 'spec', ref: 'req:acme#1FR' }, false, null],
    [{ kind: 'spec', ref: 'req:acme:x#FR-1' }, false, null],
    [{ kind: 'spec', ref: 'req:.acme#FR-1' }, false, null],
    [{ kind: 'spec', ref: 'req:acme#FR-1\n' }, false, null],
    [{ kind: 'spec', ref: `req:${'a'.repeat(129)}#FR-1` }, false, null],
    [{ kind: 'spec', ref: `req:acme#R${'0'.repeat(64)}` }, false, null],
    [{ kind: 'doc', ref: 'req:acme#FR-1' }, false, null],
    [{ kind: 'inferred', ref: 'req:acme#FR-1' }, false, null],
  ];
  for (const format of ['claims', 'evidence']) {
    it.each(rows)(`${format}: %o is valid=%s`, (source, valid) => {
      const doc = example(format);
      const target = sourceOf(format, doc);
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, source);
      const result = validate(format, doc);
      expect(result.ok, JSON.stringify(result.errors)).toBe(valid);
      if (!valid) expect(result.errors.some((e) => /\/source(?:\/(?:ref|kind))?$/.test(e.path ?? e.instancePath ?? ''))).toBe(true);
    });
  }
  it.each(rows)('requirementRef(%o) parses only what the schema admits as structured', (source, valid, parsed) => {
    expect(requirementRef(source)).toEqual(parsed);
    if (parsed) expect(valid).toBe(true);
  });
  it('exports one pattern the schema shares', () => {
    const common = JSON.parse(readFileSync(new URL('../schemas/common.schema.json', import.meta.url), 'utf8'));
    const ref = common.$defs.claimSource.properties.ref;
    expect(ref.pattern).toContain(REQUIREMENT_REF_PATTERN.source.replace(/^\^/, '').replace(/\$$/, ''));
    for (const schema of ['claims', 'evidence']) {
      expect(readFileSync(new URL(`../schemas/${schema}.schema.json`, import.meta.url), 'utf8')).toContain('urn:claimspec:v1:common#/$defs/claimSource');
    }
  });
  it('rejects malformed or non-object sources without guessing', () => {
    for (const source of [undefined, null, 'req:acme#FR-1', { ref: 'req:acme#FR-1' }, { kind: 'spec', ref: 42 }]) {
      expect(requirementRef(source)).toBe(null);
    }
  });
});
