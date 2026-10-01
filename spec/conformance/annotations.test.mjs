import { describe, it, expect } from 'vitest';
import { validate } from '../lib/validate.mjs';

const preview = () => ({ schemaVersion: 1, tool: { name: 'testguard', version: '0.0.0' }, mode: 'preview', state: 'preview', selected: ['A-1'], targets: [{ file: 'src/a.mjs', claimIds: ['A-1'], action: 'add' }], refused: [] });
const applied = () => ({ ...preview(), mode: 'apply', state: 'applied', outcome: { changed: ['src/a.mjs'], touched: ['src/a.mjs'], unchanged: [], failed: [], recoveryDir: '/private/recovery', lockRelease: { released: true } } });

describe('annotation authoring conformance', () => {
  it('admits preview, verified apply and explicit partial failure', () => {
    expect(validate('annotations', preview()).errors).toEqual([]);
    const doc = applied();
    expect(validate('annotations', doc).errors).toEqual([]);
    doc.state = 'partial'; doc.outcome.changed = []; doc.outcome.failed = [{ file: 'src/a.mjs', stage: 'source-write', reason: 'interrupted' }];
    expect(validate('annotations', doc).errors).toEqual([]);
  });
  it.each([
    ['preview cannot claim apply', (d) => { d.state = 'applied'; }],
    ['no silent omitted claim', (d) => { d.selected.push('B-1'); }],
    ['no unknown target claim', (d) => { d.targets[0].claimIds = ['B-1']; }],
    ['no duplicate target', (d) => { d.targets.push({ ...d.targets[0] }); }],
    ['no optimistic refused preview', (d) => { d.refused = [{ file: 'src/b.mjs', claimIds: ['A-1'], reason: 'unsupported-source' }]; }],
    ['no leaked internal bytes', (d) => { d.targets[0].source = 'secret'; }],
    ['no verdict', (d) => { d.verdict = 'killed'; }],
    ['no unsafe admitted path', (d) => { d.targets[0].file = '../escape.mjs'; }],
    ['no noncanonical admitted path', (d) => { d.targets[0].file = 'src/./a.mjs'; }],
  ])('rejects %s', (_, mutate) => {
    const doc = preview(); mutate(doc);
    expect(validate('annotations', doc).ok).toBe(false);
  });
  it.each([
    ['missing outcome', (d) => { delete d.outcome; }],
    ['unverified target', (d) => { d.outcome.changed = []; }],
    ['changed without touched', (d) => { d.outcome.touched = []; }],
    ['failed apply', (d) => { d.outcome.failed = [{ file: null, stage: 'journal', reason: 'failed' }]; }],
    ['unreleased lock', (d) => { d.outcome.lockRelease.released = false; }],
    ['missing recovery', (d) => { delete d.outcome.recoveryDir; }],
    ['untruthful unchanged', (d) => { d.outcome.unchanged = ['src/a.mjs']; }],
    ['unknown touched path', (d) => { d.outcome.touched.push('src/b.mjs'); }],
    ['partial cannot override admission refusal', (d) => {
      d.state = 'partial'; d.selected.push('B-1');
      d.refused.push({ file: 'src/b.mjs', claimIds: ['B-1'], reason: 'target-missing' });
      d.outcome.failed.push({ file: 'src/a.mjs', stage: 'completion-journal', reason: 'failed' });
    }],
  ])('rejects %s', (_, mutate) => {
    const doc = applied(); mutate(doc);
    expect(validate('annotations', doc).ok).toBe(false);
  });
});
