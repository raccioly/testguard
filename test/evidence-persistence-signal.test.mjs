import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistenceSignalsFor } from '../src/supply/persistence.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = () => JSON.parse(readFileSync(join(ROOT, 'spec/conformance/examples/evidence-persistence-signal.json'), 'utf8'));

// The signal the sweep document carried alone until claimspec v1 admitted it
// to `evidence.defenders.signals`. Two halves of one rule: the producer keeps
// the write-path half (a record does not carry the fault's line), the
// validator keeps the verdict half.
describe('persistenceSignalsFor — a survivor on the write path, and nothing else', () => {
  const found = [{ file: 't.test.ts', signal: 'persistence-payload-unasserted', reason: 'mocks ../db; 1 partial call assertion in the file.' }];
  const analyze = () => found;
  const onPath = { faultClass: 'field-dropped', find: '    data: { email, name },', description: 'Field dropped: `name` is no longer written.' };
  const offPath = { faultClass: 'condition-forced', find: '  if (!user) return null;', description: 'Guard never triggers.' };
  const args = (over) => ({ verdict: 'survived', fault: onPath, defenders: ['t.test.ts'], projectDir: '/nowhere', ...over });

  it('attaches what the analysis found to a survivor on the write path', () =>
    expect(persistenceSignalsFor(args(), analyze)).toEqual(found));

  it('never to a kill — there it explains nothing', () =>
    expect(persistenceSignalsFor(args({ verdict: 'killed' }), analyze)).toEqual([]));

  it('never to nocover or unverifiable — the question was never asked', () => {
    expect(persistenceSignalsFor(args({ verdict: 'nocover', defenders: [] }), analyze)).toEqual([]);
    expect(persistenceSignalsFor(args({ verdict: 'unverifiable' }), analyze)).toEqual([]);
  });

  it('never off the write path — a loose mock assertion on a guard is not evidence of anything', () =>
    expect(persistenceSignalsFor(args({ fault: offPath }), analyze)).toEqual([]));

  it('passes the project directory and the resolved defenders to the analysis, not a guess', () => {
    const seen = [];
    persistenceSignalsFor(args({ defenders: ['a.test.ts', 'b.test.ts'] }), (dir, defs) => { seen.push([dir, defs]); return []; });
    expect(seen).toEqual([['/nowhere', ['a.test.ts', 'b.test.ts']]]);
  });
});

describe('claimspec evidence — the signal is admitted, and only where it means something', () => {
  const withRecord = (mutate) => {
    const doc = example();
    const r = doc.records[0];
    mutate(r);
    r.fingerprint = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file, verdict: r.verdict });
    return doc;
  };
  const errs = (doc) => validate('evidence', doc).errors.map((e) => e.message);

  it('the conformance example validates, counts and specifiers included', () =>
    expect(validate('evidence', example())).toEqual({ ok: true, errors: [] }));

  it('on any verdict but survived the document is refused', () => {
    const doc = withRecord((r) => { r.verdict = 'unverifiable'; r.detail.reason = 'subject-not-executed'; r.detail.probeRuns = []; r.detail.negativeControl = 'not-reached'; });
    expect(errs(doc).join()).toMatch(/explains a survivor; on a unverifiable record it explains nothing/);
  });

  it('the file must be a resolved defender — it mocks the layer, not the subject', () => {
    const doc = withRecord((r) => { r.defenders.signals[0].file = 'test/other.test.mjs'; });
    expect(errs(doc).join()).toMatch(/mocks the persistence layer but is not a resolved defender/);
    // And it is never a mocking file: that list is for tests that replaced the subject.
    expect(errs(doc).join()).not.toMatch(/not listed in defenders.mocking/);
  });

  it('the reason is required — a signal that names nothing cannot be acted on', () => {
    const doc = withRecord((r) => { delete r.defenders.signals[0].reason; });
    expect(errs(doc).join()).toMatch(/requires the mocked layer and assertion mix as its reason/);
  });

  it('a signal no consumer knows is still refused: the enum stays closed', () => {
    const doc = withRecord((r) => { r.defenders.signals[0].signal = 'something-new'; });
    expect(validate('evidence', doc).ok).toBe(false);
  });
});
