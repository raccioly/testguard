// #301 item 8: `probe --changed <ref> --explain` says which claims a change
// selects and why, and probes nothing. These hold the scope it reports, the
// lines it prints and the document rules that keep an explanation from
// passing for a measurement.
import { describe, expect, it } from 'vitest';
import { explainScope, renderExplain, renderReason } from '../src/commands/probe-scope.mjs';
import { runErrors } from '../spec/lib/run-result.mjs';
import { SCOPE_NOTE } from '../src/probe/scope.mjs';

const changed = (over = {}) => ({
  ref: 'origin/main', outcome: 'determined', base: 'a'.repeat(40), head: 'b'.repeat(40), includeDirty: false,
  files: ['AGENTS.md', 'src/orphan.mjs'], matchedClaims: ['DOCS-NAMED', 'CLOSURE-OPEN'],
  matchReasons: [{ claimId: 'DOCS-NAMED', kind: 'file', file: 'AGENTS.md' }, { claimId: 'CLOSURE-OPEN', kind: 'indeterminate', issue: { code: 'computed-specifier', file: 'src/load.mjs', specifier: 'plugin' } }],
  unmatchedFiles: ['src/orphan.mjs'], note: SCOPE_NOTE, ...over,
});

describe('the scope --explain reports', () => {
  it('a selection: what would be probed, with nothing probed, exit 0', () => {
    const r = explainScope({ outcome: 'selected', only: ['DOCS-NAMED', 'CLOSURE-OPEN'], changed: changed() });
    expect(r).toEqual({ exitCode: 0, scope: { probedClaims: [], probedCount: 0, selectedCount: 2, explain: true, changed: changed() } });
    expect(runErrors({ exitCode: r.exitCode, scope: r.scope })).toEqual([]);
  });

  it('an empty selection exits 0 even under --fail-on-empty-selection; an undetermined change exits 2', () => {
    const empty = { outcome: 'empty', exitCode: 2, scope: { probedClaims: [], probedCount: 0, selectedCount: 0, changed: changed({ matchedClaims: [], matchReasons: [] }) } };
    expect(explainScope(empty).exitCode).toBe(0);
    const undetermined = { outcome: 'undetermined', exitCode: 2, scope: { probedClaims: [], probedCount: 0, changed: { ref: 'nope', outcome: 'undetermined', reason: { kind: 'ref-unresolved', message: 'resolve-ref: nope' } } } };
    const r = explainScope(undetermined);
    expect(r.exitCode).toBe(2);
    expect(runErrors({ exitCode: r.exitCode, scope: r.scope })).toEqual([]);
  });

  it('keeps the --claim intersection it was asked for', () => {
    const r = explainScope({ outcome: 'selected', only: ['DOCS-NAMED'], changed: changed() }, { requested: ['DOCS-NAMED'] });
    expect(r.scope).toMatchObject({ requestedClaims: ['DOCS-NAMED'], requestedCount: 1, selectedCount: 1 });
    expect(runErrors({ exitCode: 0, scope: r.scope })).toEqual([]);
  });
});

describe('the document rules for an explanation', () => {
  const scope = { probedClaims: [], probedCount: 0, selectedCount: 2, explain: true, changed: changed() };
  it('never carries a measurement', () => {
    expect(runErrors({ exitCode: 0, id: 'run-1', evidence: 'e.json', provisional: false, records: 0, newSinceBaseline: 0, scope }).map((e) => e.path)).toContain('/run/id');
  });
  it('exits 0 for a determined change: an explanation judges nothing', () => {
    expect(runErrors({ exitCode: 1, scope }).map((e) => e.path)).toContain('/run/exitCode');
  });
  it('without explain, selected claims and no measurement are still refused', () => {
    expect(runErrors({ exitCode: 0, scope: { ...scope, explain: undefined } }).map((e) => e.path)).toContain('/run/id');
  });
  it('explains a --changed selection, never a bare --claim request', () => {
    expect(runErrors({ exitCode: 0, scope: { requestedClaims: ['A'], requestedCount: 1, probedClaims: [], probedCount: 0, explain: true } }).map((e) => e.path)).toContain('/run/scope/explain');
  });
});

describe('the lines --explain prints', () => {
  it('one line per selected claim and its reason, a count per kind, and the uncovered files', () => {
    const lines = renderExplain({ exitCode: 0, scope: { probedClaims: [], probedCount: 0, selectedCount: 2, explain: true, changed: changed() } }, { total: 5 });
    expect(lines[0]).toBe('--changed origin/main: 2 of 5 claims selected; 2 files differ since merge-base aaaaaaa. Nothing was probed (--explain).');
    expect(lines[1]).toBe('  DOCS-NAMED    file AGENTS.md');
    expect(lines[2]).toMatch(/^ {2}CLOSURE-OPEN {2}indeterminate computed-specifier in src\/load\.mjs \(plugin\)/);
    expect(lines).toContain('by reason: file 1, glob 0, discovery 0, indeterminate 1');
    expect(lines.some((line) => line.includes('src/orphan.mjs') && line.includes(SCOPE_NOTE))).toBe(true);
  });

  it('names each kind of reason by what changed', () => {
    expect(renderReason({ kind: 'file', file: 'testguard.config.json' })).toContain('every claim depends on it');
    expect(renderReason({ kind: 'glob', file: 'test/a.test.mjs', glob: 'test/*.test.mjs' })).toBe('glob test/a.test.mjs (matches defendedBy test/*.test.mjs)');
    expect(renderReason({ kind: 'discovery', file: 'test/b.test.mjs' })).toMatch(/^discovery test\/b\.test\.mjs/);
    expect(renderReason({ kind: 'indeterminate' })).toMatch(/^indeterminate \(/);
  });

  it('says an empty selection is not a pass', () => {
    const lines = renderExplain({ exitCode: 0, scope: { probedClaims: [], probedCount: 0, selectedCount: 0, explain: true, changed: changed({ matchedClaims: [], matchReasons: [] }) } }, { total: 5 });
    expect(lines.at(-1)).toMatch(/not a pass for the change/);
  });
});
