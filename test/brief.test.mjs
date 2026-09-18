// @req FR-07
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderBriefMarkdown, renderUnclaimedMarkdown, MARKDOWN_MARKER, buildBrief, buildUnclaimedBrief, HEADING, hintFor } from '../src/brief/brief.mjs';
import { buildBaseline } from '../src/baseline/baseline.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { renderSummary, renderRecord } from '../src/render.mjs';

const evidence = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));

describe('buildBrief', () => {
  it('conforms to the spec with and without a baseline', () => {
    expect(validate('brief', buildBrief(evidence, undefined)).errors).toEqual([]);
    expect(validate('brief', buildBrief(evidence, buildBaseline(evidence))).errors).toEqual([]);
  });
  it('text opens with the heading and names the items', () => {
    const b = buildBrief(evidence, undefined);
    expect(b.text.startsWith(HEADING)).toBe(true);
    expect(b.text).toContain('[NEW] SURVIVED  REDACT-001/F1');
  });
  it('puts new findings before baselined ones, survivors first', () => {
    const partial = { fingerprints: { [evidence.records[0].fingerprint]: 1 } }; // baseline only the survivor
    const b = buildBrief(evidence, partial);
    expect(b.items[0].isNew).toBe(true);
    expect(b.items[b.items.length - 1]).toMatchObject({ isNew: false, verdict: 'survived' });
    expect(b.summary.baselined).toBe(1);
  });
  it('caps at max and says how many more there are', () => {
    const b = buildBrief(evidence, undefined, { max: 1 });
    expect(b.items).toHaveLength(1);
    expect(b.text).toMatch(/and \d+ more in the evidence file/);
  });
  it('says so when everything is defended', () => {
    const allKilled = { ...evidence, records: evidence.records.filter((r) => r.verdict === 'killed') };
    const b = buildBrief(allKilled, undefined);
    expect(b.items).toEqual([]);
    expect(b.text).toContain('Every probed claim is defended');
    expect(validate('brief', b).ok).toBe(true);
  });
  it('hints name the mechanism, not just the verdict', () => {
    const byVerdict = Object.fromEntries(evidence.records.map((r) => [r.verdict, r]));
    expect(hintFor(byVerdict.survived)).toContain('stayed green');
    // the example's nocover record is discovered with a mocking candidate: the hint says so, and names the signal
    expect(hintFor(byVerdict.nocover)).toContain('No test file imports the target without mocking it');
    expect(hintFor(byVerdict.nocover)).toMatch(/test\/rules-mocked\.test\.mjs mocks it and never asserts on it/);
    expect(hintFor({ ...byVerdict.nocover, defenders: { requested: ['test/rules.test.mjs'], resolved: [], nocover: true } })).toContain('No test file matches test/rules.test.mjs');
    expect(hintFor(byVerdict.unverifiable)).toContain('anchor-missing');
    expect(hintFor(byVerdict['flaky-defender'])).toContain('not reliably green');
  });
});

describe('renderSummary', () => {
  it('counts unproven faults AND the distinct claims they belong to', () => {
    const line = renderSummary(evidence.records);
    expect(line).toMatch(/\d+ unproven faults across \d+ claims\./);
    const unproven = evidence.records.filter((r) => r.verdict !== 'killed');
    expect(line).toContain(`${unproven.length} unproven fault`);
    expect(line).toContain(`across ${new Set(unproven.map((r) => r.claim.id)).size} claim`);
  });
});

describe('renderRecord', () => {
  it('names the undeclared killers by file and shows anchor hit counts', () => {
    const base = evidence.records[0];
    const killed = { ...base, detail: { ...base.detail, reason: 'killed-by-undeclared-tests', undeclaredKillers: ['test/a.test.mjs::x', 'test/a.test.mjs::y', 'test/b.test.mjs::z'] } };
    expect(renderRecord(killed)).toContain('[killed-by-undeclared-tests: test/a.test.mjs, test/b.test.mjs]');
    const amb = { ...base, verdict: 'unverifiable', detail: { reason: 'anchor-ambiguous', anchor: { hits: 6, expected: 1 }, baselineRuns: [], probeRuns: [] } };
    expect(renderRecord(amb)).toContain('[anchor-ambiguous: 6 hits, expected 1]');
    expect(renderRecord({ ...base, defenders: { ...base.defenders, discovered: true } })).toContain('(defenders discovered by import)');
  });
});

describe('provisional rendering', () => {
  it('marks verdicts with "?" and prefixes the summary when the run is provisional', () => {
    const r = evidence.records[0];
    expect(renderRecord(r, { provisional: true })).toMatch(/^SURVIVED\?/);
    expect(renderRecord(r)).toMatch(/^SURVIVED /);
    expect(renderSummary(evidence.records, { ...evidence.run, confirmRuns: 1, provisional: true })).toMatch(/^PROVISIONAL: .*SURVIVED\?/);
  });
  it('brief warns at the top when the evidence is provisional', () => {
    const prov = { ...evidence, run: { ...evidence.run, confirmRuns: 1, provisional: true } };
    const b = buildBrief(prov, undefined);
    expect(b.text.split('\n')[2]).toMatch(/^\*\*PROVISIONAL\*\*/);
    expect(buildBrief(evidence, undefined).text).not.toContain('PROVISIONAL');
  });
  it('puts unclaimed changes before every finding, and can brief them with no evidence at all', () => {
    const changes = { ref: 'origin/main', base: 'a'.repeat(40), changed: 2, evaluated: 1, excluded: 1, uncovered: [{ file: 'src/export.mjs', kind: 'source', suggestion: 'testguard scaffold src/export.mjs' }], reliedOn: [], expired: [] };
    const next = { action: 'claim', command: 'testguard scaffold src/export.mjs', why: 'src/export.mjs carries no claim.' };
    const b = buildBrief(evidence, undefined, { next, changes });
    expect(validate('brief', b).errors).toEqual([]);
    expect(b.unclaimed).toEqual({ ref: 'origin/main', files: changes.uncovered });
    const text = b.text;
    expect(text.indexOf('UNCLAIMED CHANGES since origin/main')).toBeGreaterThan(text.indexOf(HEADING));
    expect(text.indexOf('UNCLAIMED CHANGES since origin/main')).toBeLessThan(text.indexOf('NEXT [claim]'));
    expect(text.indexOf('UNCLAIMED CHANGES since origin/main')).toBeLessThan(text.indexOf('1. '));
    expect(text).toContain('  - src/export.mjs (source) → testguard scaffold src/export.mjs');
    expect(buildBrief(evidence, undefined, { next }).unclaimed).toBeUndefined();

    const u = buildUnclaimedBrief({ tool: { name: 'testguard', version: 't' }, next, changes });
    expect(validate('brief', u).errors).toEqual([]);
    expect(u.text.startsWith(HEADING)).toBe(true);
    expect(u.text).toContain('no evidence yet; 1 unclaimed changed file since origin/main');
    expect(u.items).toEqual([]);
  });

  describe('markdown rendering (merge-request note)', () => {
    const md = (b, opts = {}) => renderBriefMarkdown(b, { hasBaseline: false, total: evidence.records.length, ...opts });
    it('starts with the marker so a poster can update its own note, then the heading, then a table of at most --max rows', () => {
      const b = buildBrief(evidence, undefined, { max: 2 });
      const text = md(b);
      const lines = text.split('\n');
      expect(lines[0]).toBe(MARKDOWN_MARKER);
      expect(lines[1]).toBe('## TEST BLINDSPOT CONTEXT');
      expect(text).toContain('| # | verdict | claim / fault | severity | file | what to do |');
      expect(lines.filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(2);
      expect(text).toMatch(/… and \d+ more in the evidence file\./);
      expect(text).toContain('**NEW** SURVIVED');
    });
    it('puts unclaimed changes and next BEFORE the findings table, like the text', () => {
      const next = { action: 'claim', command: 'testguard scaffold src/new.ts', why: 'one changed file carries no claim' };
      const changes = { ref: 'origin/main', uncovered: [{ file: 'src/new.ts', kind: 'source', suggestion: 'testguard scaffold src/new.ts' }] };
      const text = md(buildBrief(evidence, undefined, { next, changes }));
      const i = (needle) => text.indexOf(needle);
      expect(i('### Unclaimed changes since `origin/main`')).toBeGreaterThan(0);
      expect(i('- `src/new.ts` (source) → `testguard scaffold src/new.ts`')).toBeLessThan(i('**Next** `[claim]`'));
      expect(i('**Next** `[claim]`')).toBeLessThan(i('| # | verdict |'));
    });
    it('says every claim is defended when nothing is unproven; flags provisional evidence; escapes pipes in cells', () => {
      const killed = structuredClone(evidence);
      for (const r of killed.records) { r.verdict = 'killed'; r.detail = { baselineRuns: r.detail.baselineRuns, probeRuns: r.detail.probeRuns }; }
      expect(md(buildBrief(killed, undefined), { total: killed.records.length })).toContain('Every probed claim is defended.');
      const prov = structuredClone(evidence); prov.run.provisional = true;
      expect(md({ ...buildBrief(prov, undefined), provisional: true })).toContain('**PROVISIONAL**');
      const piped = structuredClone(evidence); piped.records[0].claim.statement = 'a | b';
      const text = md(buildBrief(piped, undefined));
      expect(text).toContain('a \\| b');
    });
    it('renders the no-evidence, unclaimed-only brief with the same marker and section', () => {
      const text = renderUnclaimedMarkdown({ tool: { name: 'testguard', version: '0.0.0' }, next: { action: 'claim', command: 'x', why: 'y' }, changes: { ref: 'HEAD', uncovered: [{ file: 'a.ts', kind: 'source', suggestion: 's' }] } });
      expect(text.startsWith(`${MARKDOWN_MARKER}\n## TEST BLINDSPOT CONTEXT`)).toBe(true);
      expect(text).toContain('### Unclaimed changes since `HEAD`');
      expect(text).toContain('- `a.ts` (source) → `s`');
    });
  });
});
