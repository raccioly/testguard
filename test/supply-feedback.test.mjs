import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tallyEvidence, mergeTallies, combinedProductivity, readEvidence, learnedProductivity, renderLearned } from '../src/supply/feedback.mjs';
import { priorFor } from '../src/supply/select.mjs';

const rec = (faultClass, verdict) => ({ subject: { faultClass }, verdict });
const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-feedback-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

describe('tallyEvidence — only the verdicts that answer the question', () => {
  it('counts survived against the total for each class', () => {
    const doc = { records: [rec('field-dropped', 'survived'), rec('field-dropped', 'killed'), rec('guard-removed', 'killed')] };
    expect(tallyEvidence(doc)).toEqual({ 'field-dropped': { survived: 1, n: 2 }, 'guard-removed': { survived: 0, n: 1 } });
  });

  it('ignores verdicts that say the question could not be asked', () => {
    // nocover, unverifiable, fault-invalid, timeout and flaky-defender say
    // nothing about whether a fault of that class would be NOTICED. Folding
    // them in either direction would be inventing data.
    const doc = { records: ['nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender'].map((v) => rec('field-dropped', v)) };
    expect(tallyEvidence(doc)).toEqual({});
  });

  it('a record with no fault class teaches nothing', () =>
    expect(tallyEvidence({ records: [{ subject: {}, verdict: 'survived' }] })).toEqual({}));

  it('an empty or absent document is not an error', () => {
    expect(tallyEvidence({ records: [] })).toEqual({});
    expect(tallyEvidence(undefined)).toEqual({});
  });
});

describe('combinedProductivity — the shipped number is a prior, not a rival', () => {
  it('a project with its own records moves the prior toward what it saw', () => {
    const shipped = { 'field-dropped': { p: 0.5, n: 12 } };
    const local = { 'field-dropped': { survived: 40, n: 45 } };
    const t = combinedProductivity(local, shipped);
    expect(priorFor('field-dropped', shipped)).toBeLessThan(priorFor('field-dropped', t));
    expect(t['field-dropped'].n).toBe(57);
    expect(t['field-dropped'].observed).toBe(45);
  });

  it('a project with three records nudges it; it does not override it', () => {
    const shipped = { 'field-dropped': { p: 0.5, n: 12 } };
    const nudged = combinedProductivity({ 'field-dropped': { survived: 3, n: 3 } }, shipped);
    // Three observations of 100% against twelve of 50% lands between them,
    // much nearer the prior. A single run must not rewrite the ordering.
    expect(nudged['field-dropped'].p).toBeGreaterThan(0.5);
    expect(nudged['field-dropped'].p).toBeLessThan(0.7);
  });

  it('a class only this project has seen is carried on its own count', () => {
    const t = combinedProductivity({ 'brand-new': { survived: 2, n: 4 } }, {});
    expect(t['brand-new']).toEqual({ p: 0.5, n: 4, observed: 4 });
  });

  it('a class nobody has observed is absent rather than invented at zero', () =>
    expect(combinedProductivity({}, {})).toEqual({}));

  it('is a posterior mean, so it cannot be improved by reporting a dishonest number', () => {
    // The estimator is strictly proper by construction: survived/n over the
    // combined counts. Ranking by anything else — accuracy, F1, a threshold —
    // would maximise findings while destroying the calibration of the number
    // attached to each, which is the invariant this file exists to hold.
    const t = combinedProductivity({ x: { survived: 3, n: 10 } }, { x: { p: 0.5, n: 10 } });
    expect(t.x.p).toBeCloseTo((3 + 5) / 20, 10);
  });
});

describe('mergeTallies', () => {
  it('adds counts rather than averaging rates', () => {
    const a = { g: { survived: 1, n: 4 } };
    const b = { g: { survived: 3, n: 4 } };
    expect(mergeTallies([a, b])).toEqual({ g: { survived: 4, n: 8 } });
  });
});

describe('learnedProductivity — traceable, or it should not be trusted', () => {
  const evidence = (records) => JSON.stringify({ records });

  it('reads what is there and names where it came from', () => {
    const dir = project({ '.testguard/sweep-evidence.json': evidence([rec('field-dropped', 'survived'), rec('field-dropped', 'killed')]) });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(2);
    expect(l.sources).toEqual(['.testguard/sweep-evidence.json']);
    expect(renderLearned(l)).toMatch(/2 probed faults of this project's own/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a project with no evidence says so, and falls back rather than failing', () => {
    const dir = project({ 'src/a.ts': 'x' });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(0);
    expect(renderLearned(l)).toMatch(/shipped productivity prior/);
    // The shipped table is still usable.
    expect(priorFor('field-dropped', l.table)).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts both documents when both exist', () => {
    const dir = project({
      '.testguard/sweep-evidence.json': evidence([rec('g', 'survived')]),
      '.testguard/evidence.json': evidence([rec('g', 'killed'), rec('g', 'killed')]),
    });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(3);
    expect(l.sources).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a document that taught nothing is not named as a source', () => {
    // THE SWEEP-BRICKING REGRESSION. `tallyEvidence` counts only killed and
    // survived, so evidence whose records are all `nocover` teaches nothing —
    // the ordinary shape of a first sweep on a project with no defenders
    // discovered yet. Naming it anyway produced `sources: [...]` with
    // `observed: 0`, which the sweep validator correctly refuses to write; and
    // because the document is on disk, EVERY later sweep failed the same way,
    // permanently, until someone deleted a gitignored file.
    const dir = project({ '.testguard/sweep-evidence.json': evidence([rec('field-dropped', 'nocover'), rec('g', 'unverifiable')]) });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(0);
    expect(l.sources).toEqual([]);
    // and it still falls back to the shipped prior rather than failing
    expect(renderLearned(l)).toMatch(/shipped productivity prior/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names only the documents that contributed, when one of several taught nothing', () => {
    const dir = project({
      '.testguard/sweep-evidence.json': evidence([rec('g', 'nocover')]),
      '.testguard/evidence.json': evidence([rec('g', 'survived')]),
    });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(1);
    expect(l.sources).toEqual(['.testguard/evidence.json']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a document it cannot parse is skipped, never guessed at', () => {
    // A ranking built on a guess about a corrupt file is worse than one built
    // on the shipped prior.
    const dir = project({ '.testguard/sweep-evidence.json': '{ not json', '.testguard/evidence.json': evidence([rec('g', 'survived')]) });
    const l = learnedProductivity(dir);
    expect(l.observed).toBe(1);
    expect(l.sources).toEqual(['.testguard/evidence.json']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('readEvidence returns nothing for a project that has none', () => {
    const dir = project({ 'src/a.ts': 'x' });
    expect(readEvidence(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
