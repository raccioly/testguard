// GATE-SEMANTICS rule 8: what the target and defenders import is an input to
// reuse, and an import closure that could not be followed licenses nothing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../lib/validate.mjs';

const load = (dir, name) => JSON.parse(readFileSync(new URL(`./${dir}/${name}`, import.meta.url), 'utf8'));

describe('dependency closure in evidence (rule 8)', () => {
  it('admits a reused record with a complete closure, and a measured record with an indeterminate one', () => {
    const doc = load('examples', 'evidence-dependency-closure.json');
    expect(validate('evidence', doc).errors).toEqual([]);
    expect(doc.records.map((r) => [r.inputs.dependencyClosure, Boolean(r.reusedFrom)])).toEqual([['complete', true], ['indeterminate', false]]);
    expect(doc.run.measurements.reuseBaselineRuns).toBe(1);
    expect(doc.run.reuse).toEqual({ reused: 1, measured: 1 });
    expect(doc.run.instrument.toolVersion).toBe(doc.tool.version);
  });

  it('admits legacy records without dependency hashes', () => {
    const doc = load('examples', 'evidence.json');
    expect(doc.records.every((r) => !('dependencyHashes' in r.inputs))).toBe(true);
    expect(validate('evidence', doc).errors).toEqual([]);
  });

  it.each([
    ['evidence.reused-with-indeterminate-dependency-closure.json', '/records/1/reusedFrom', /never reused/],
    ['evidence.indeterminate-dependency-closure-without-reason.json', '/records/1/inputs/dependencyIssues', /must name at least one reason/],
    ['evidence.dependency-hashes-without-closure-state.json', '/records/0/inputs', /dependencyClosure/],
    ['evidence.instrument-names-another-tool-version.json', '/run/instrument/toolVersion', /not the tool that wrote this evidence/],
    ['evidence.reuse-tally-disagrees-with-records.json', '/run/reuse', /1 reused, 1 measured/],
  ])('rejects %s for the reason it names', (file, path, message) => {
    const { errors } = validate('evidence', load('invalid', file));
    expect(errors).toEqual([expect.objectContaining({ path, message: expect.stringMatching(message) })]);
  });

  it('rejects issues on a complete closure', () => {
    const doc = load('examples', 'evidence-dependency-closure.json');
    doc.records[0].inputs.dependencyIssues = [{ code: 'graph-limit', file: 'src/a.ts' }];
    expect(validate('evidence', doc).errors).toEqual([expect.objectContaining({ path: '/records/0/inputs/dependencyIssues', message: 'a complete dependency closure has no issues' })]);
  });
});
