import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildBaseline, gate, restampBaseline, sameFingerprints } from '../src/baseline/baseline.mjs';
import { validate } from '../spec/lib/validate.mjs';

const evidence = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));

describe('buildBaseline', () => {
  const baseline = buildBaseline(evidence, { createdAt: '2026-09-17T00:00:00Z' });
  it('conforms to the spec', () => expect(validate('baseline', baseline).errors).toEqual([]));
  it('never fingerprints a kill', () => {
    const killed = evidence.records.filter((r) => r.verdict === 'killed').map((r) => r.fingerprint);
    for (const fp of killed) expect(baseline.fingerprints[fp]).toBeUndefined();
    expect(Object.values(baseline.fingerprints).reduce((a, b) => a + b, 0)).toBe(evidence.records.length - killed.length);
  });
  it('carries the head the evidence was taken at', () => expect(baseline.head).toBe(evidence.run.repo.head));
});

describe('gate', () => {
  const unproven = evidence.records.filter((r) => r.verdict !== 'killed');
  it('everything unproven is new without a baseline', () => {
    const g = gate(evidence.records, undefined);
    expect(g.new).toHaveLength(unproven.length);
    expect(g.killed).toHaveLength(evidence.records.length - unproven.length);
  });
  it('a full baseline suppresses everything', () => {
    const g = gate(evidence.records, buildBaseline(evidence));
    expect(g.new).toEqual([]);
    expect(g.baselined).toHaveLength(unproven.length);
  });
  it('suppresses up to count, then gates', () => {
    const first = unproven[0];
    const twice = [first, first];
    const g = gate(twice, { fingerprints: { [first.fingerprint]: 1 } });
    expect(g.baselined).toHaveLength(1);
    expect(g.new).toHaveLength(1);
  });
  it('a severity floor moves new findings below it out of the gate but not out of the report', () => {
    const g = gate(evidence.records, undefined, { severityFloor: 'critical' });
    expect(g.new.every((r) => r.claim.severity === 'critical')).toBe(true);
    expect(g.belowFloor.length + g.new.length).toBe(unproven.length);
  });
  it('baseline wins over the floor', () => {
    const g = gate(evidence.records, buildBaseline(evidence), { severityFloor: 'critical' });
    expect(g.belowFloor).toEqual([]);
  });
});

describe('a baseline frozen from a working-tree snapshot, and re-stamping it', () => {
  const snapEvidence = { ...evidence, run: { ...evidence.run, repo: { head: evidence.run.repo.head, dirty: true, snapshot: 'b'.repeat(40) } } };
  const frozen = buildBaseline(snapEvidence, { createdAt: '2026-09-17T00:00:00Z' });
  it('carries the snapshot and conforms', () => {
    expect(frozen.snapshot).toBe('b'.repeat(40));
    expect(frozen.dirty).toBe(true);
    expect(validate('baseline', frozen).errors).toEqual([]);
  });
  it('re-stamps to a later CLEAN probe that reproduced the same fingerprints, dropping the snapshot and keeping createdAt', () => {
    const later = { ...evidence, run: { ...evidence.run, repo: { head: 'c'.repeat(40), dirty: false } } };
    const r = restampBaseline(frozen, later, { restampedAt: '2026-09-18T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.baseline).toMatchObject({ head: 'c'.repeat(40), dirty: false, createdAt: '2026-09-17T00:00:00Z', restampedAt: '2026-09-18T00:00:00Z' });
    expect(r.baseline.snapshot).toBeUndefined();
    expect(sameFingerprints(r.baseline.fingerprints, frozen.fingerprints)).toBe(true);
    expect(validate('baseline', r.baseline).errors).toEqual([]);
  });
  it('refuses a dirty or snapshot probe, and refuses when the fingerprints differ — a frozen contract is never silently rewritten', () => {
    expect(restampBaseline(frozen, snapEvidence).ok).toBe(false);
    expect(restampBaseline(frozen, snapEvidence).reason).toMatch(/snapshot/);
    const dirty = { ...evidence, run: { ...evidence.run, repo: { head: 'c'.repeat(40), dirty: true } } };
    expect(restampBaseline(frozen, dirty).reason).toMatch(/dirty tree/);
    const fewer = { ...evidence, run: { ...evidence.run, repo: { head: 'c'.repeat(40), dirty: false } }, records: evidence.records.slice(1) };
    const r = restampBaseline(frozen, fewer);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not reproduce/);
  });
});
