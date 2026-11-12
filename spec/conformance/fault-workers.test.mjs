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

describe('the fan-out guard (#270)', () => {
  it('a fan-out records how its width was chosen, and its guard cost', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    expect(doc.run.faultWorkersSource).toBe('auto');
    expect(doc.run.cpus).toBe(8);
    expect(doc.run.measurements.aloneConfirmRuns).toBe(1);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it('a kill under a fan-out with no run measured alone is refused', () => {
    expect(paths(load('invalid', 'evidence.fan-out-kill-without-alone-run.json'))).toEqual(['/records/0/detail/probeRuns']);
  });

  it('a record measured again alone has every probe run alone', () => {
    expect(paths(load('invalid', 'evidence.remeasured-not-alone.json'))).toEqual(['/records/2/detail/probeRuns']);
  });

  it('a serial run records no alone marks: every run is alone by definition', () => {
    expect(paths(load('invalid', 'evidence.alone-without-fan-out.json'))).toEqual(['/records/0/detail/probeRuns/2/alone']);
  });

  it('an automatic width records the CPUs it came from, and only an automatic one does', () => {
    expect(paths(load('invalid', 'evidence.auto-fault-workers-without-cpus.json'))).toEqual(['/run/cpus']);
    const doc = load('examples', 'evidence-fault-workers.json');
    doc.run.faultWorkersSource = 'flag';
    expect(paths(doc)).toEqual(['/run/cpus']);
  });

  it('one fault at a time by request records no fan-out and no guard cost', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    doc.run.faultWorkersSource = 'serial';
    delete doc.run.cpus;
    expect(paths(doc)).toContain('/run/faultWorkers');
    delete doc.run.faultWorkers;
    expect(paths(doc)).toEqual(expect.arrayContaining(['/run/measurements/aloneConfirmRuns', '/records/2/detail/remeasuredSerially']));
  });

  it('a kill in a set that is not parallel-safe rests only on runs alone', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    doc.records[0].detail.notParallelSafe = true;
    expect(paths(doc)).toEqual(['/records/0/detail/probeRuns']);
    doc.records[0].detail.probeRuns.forEach((run) => { run.alone = true; });
    expect(paths(doc)).toEqual([]);
  });

  it('a reused fan-out record keeps its marks in a run of another width', () => {
    const doc = load('examples', 'evidence-fault-workers.json');
    delete doc.run.faultWorkers;
    doc.run.faultWorkersSource = 'auto';
    for (const key of ['aloneConfirmRuns', 'aloneConfirmMs', 'remeasuredFaults', 'remeasureMs']) delete doc.run.measurements[key];
    for (const record of doc.records) record.reusedFrom = 'run-20260101T000000';
    expect(paths(doc).filter((p) => p.startsWith('/records'))).toEqual([]);
  });
});
