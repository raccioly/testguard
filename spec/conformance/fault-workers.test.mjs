// `run.faultWorkers` and `detail.remeasuredSerially` (issue #237). The generic
// suite only checks that each invalid document fails; this one pins WHY.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir, file) => JSON.parse(readFileSync(join(here, dir, file), 'utf8'));
const paths = (doc) => validate('evidence', doc).errors.map((e) => e.path);

describe('fault fan-out evidence', () => {
  it('a fan-out with a serially re-measured record conforms', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    expect(doc.run.faultWorkers).toBe(3);
    expect(doc.records.some((r) => r.detail.remeasuredSerially === true)).toBe(true);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('a serial re-measure without a fan-out describes a run that cannot have happened', () => {
    expect(paths(load('invalid', 'evidence.remeasured-without-fan-out.json'))).toContain('/records/2/detail/remeasuredSerially');
  });

  it('a fan-out cannot be measured in place', () => {
    expect(paths(load('invalid', 'evidence.fault-workers-in-place.json'))).toContain('/run/faultWorkers');
  });

  it('a serial run omits the field: one value, one spelling', () => {
    expect(paths(load('invalid', 'evidence.fault-workers-one-recorded.json'))).toContain('/run/faultWorkers');
  });

  it('remeasuredSerially is only ever true', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    doc.records[2].detail.remeasuredSerially = false;
    expect(paths(doc)).toContain('/records/2/detail/remeasuredSerially');
  });
});

describe('baseline fan-out evidence', () => {
  it('a record whose baseline was re-measured alone conforms under a fan-out', () => {
    const doc = load('examples', 'evidence-fault-workers-baseline.json');
    expect(doc.records[0].detail.baselineRemeasuredSerially).toBe(true);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('a baseline re-measure without a fan-out describes a run that cannot have happened', () => {
    expect(paths(load('invalid', 'evidence.baseline-remeasured-without-fan-out.json'))).toEqual(['/records/0/detail/baselineRemeasuredSerially']);
  });

  it('baselineRemeasuredSerially is only ever true', () => {
    const doc = load('examples', 'evidence-fault-workers-baseline.json');
    doc.records[0].detail.baselineRemeasuredSerially = false;
    expect(paths(doc)).toContain('/records/0/detail/baselineRemeasuredSerially');
  });
});
