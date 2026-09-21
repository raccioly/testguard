import { describe, it, expect } from 'vitest';
import { validate } from '../spec/lib/validate.mjs';
import { renderSweep, findingFrom, sortFindings, gatingCount, GATING } from '../src/sweep/sweep.mjs';

const finding = (over = {}) => ({
  file: 'src/a.ts',
  claimId: 'A-FILE',
  faultId: 'S1',
  faultClass: 'field-dropped',
  verdict: 'survived',
  description: '[line 9] Field dropped: `email` is no longer written.',
  writePath: true,
  hint: 'assert the whole object written by the call this fault changes',
  ...over,
});

const doc = (over = {}) => ({
  schemaVersion: 1,
  tool: { name: 'testguard', version: '0.10.4' },
  generatedAt: '2026-09-21T00:00:00.000Z',
  ref: 'origin/main',
  base: '0'.repeat(40),
  head: '1'.repeat(40),
  includeDirty: false,
  scope: { changed: 3, targets: 2, swept: 2 },
  selection: { proposed: 5, selected: 2, deferred: 3, cap: 14, byClass: { 'field-dropped': { proposed: 5, selected: 2, writePath: 5 } } },
  counts: { survived: 1, killed: 1 },
  findings: [finding()],
  exitCode: 1,
  ...over,
});

const errs = (d) => validate('sweep', d).errors.map((e) => e.message);

describe('sweep document — the arithmetic that proves nothing was hidden', () => {
  it('a conforming document validates', () => expect(validate('sweep', doc())).toEqual({ ok: true, errors: [] }));

  it('selected + deferred must account for every proposal', () => {
    // A cap that hides its own remainder is a coverage claim nobody made.
    expect(errs(doc({ selection: { ...doc().selection, deferred: 2 } }))[0]).toMatch(/proposed \(5\) must equal selected \(2\) \+ deferred \(2\)/);
  });

  it('a selection cannot exceed its own cap', () =>
    expect(errs(doc({ selection: { ...doc().selection, cap: 1 } })).join()).toMatch(/exceeds the cap/));

  it('the per-class tally must agree with the totals it is a breakdown of', () => {
    expect(errs(doc({ selection: { ...doc().selection, byClass: { 'field-dropped': { proposed: 4, selected: 2, writePath: 4 } } } })).join()).toMatch(/byClass proposed sums to 4/);
    expect(errs(doc({ selection: { ...doc().selection, byClass: { 'field-dropped': { proposed: 5, selected: 1, writePath: 5 } } } })).join()).toMatch(/byClass selected sums to 1/);
  });

  it('more verdicts than selected faults is a document describing a run that cannot have happened', () =>
    expect(errs(doc({ counts: { survived: 2, killed: 2 } })).join()).toMatch(/4 verdicts recorded for 2 selected faults/));

  it('findings are every record that was not killed — no more, no fewer', () =>
    expect(errs(doc({ counts: { survived: 1, killed: 0, nocover: 1 } })).join()).toMatch(/1 findings for 2 records that were not killed/));

  it('a killed fault is never a finding', () =>
    expect(errs(doc({ counts: { killed: 2 }, findings: [finding({ verdict: 'killed' })], exitCode: 0 })).join()).toMatch(/a killed fault is not a finding/));
});

describe('sweep exit code — what a sweep is willing to fail on', () => {
  it('a survivor exits 1', () =>
    expect(errs(doc({ exitCode: 0 })).join()).toMatch(/must exit 1/));

  it('an untested file exits 1', () => {
    const d = doc({ counts: { nocover: 1, killed: 1 }, findings: [finding({ verdict: 'nocover', writePath: false, hint: 'no test file imports the target' })], exitCode: 1 });
    expect(validate('sweep', d).ok).toBe(true);
  });

  it('a proposal the tool could not anchor does NOT fail the sweep', () => {
    // The faults are machine-made and thrown away. Failing because its own
    // guess would not compile is the fastest way to get a check switched off.
    const d = doc({
      counts: { 'fault-invalid': 1, unverifiable: 1 },
      findings: [
        finding({ verdict: 'fault-invalid', reason: 'replacement-does-not-compile', writePath: false, hint: 'fix the fault definition, not the code' }),
        finding({ faultId: 'S2', verdict: 'unverifiable', reason: 'anchor-missing', writePath: false, hint: 'anchor anchor-missing' }),
      ],
      exitCode: 0,
    });
    expect(validate('sweep', d)).toEqual({ ok: true, errors: [] });
    expect(errs({ ...d, exitCode: 1 }).join()).toMatch(/does not fail on its own unanchorable proposal/);
  });
});

describe('sweep signals — attached to a verdict the probe already reached', () => {
  const signal = [{ file: 't.test.ts', signal: 'persistence-payload-unasserted', reason: 'mocks @/lib/prisma; 3 argument-free call assertions in the file.' }];

  it('belong to a survivor on the write path', () =>
    expect(validate('sweep', doc({ findings: [finding({ signals: signal })] })).ok).toBe(true));

  it('never to a finding off the write path, where a loose mock assertion says nothing', () =>
    expect(errs(doc({ findings: [finding({ writePath: false, signals: signal })] })).join()).toMatch(/signals belong to a survived finding on the write path/));

  it('never to a verdict other than survived', () =>
    expect(errs(doc({ counts: { nocover: 1, killed: 1 }, findings: [finding({ verdict: 'nocover', signals: signal })] })).join()).toMatch(/signals belong to a survived finding/));
});

describe('renderSweep — says what it did not do, as well as what it did', () => {
  it('names the deferred count as a non-verdict', () => {
    const text = renderSweep(doc());
    expect(text).toMatch(/proposed 5 faults, probed 2 \(cap 14\), deferred 3/);
    expect(text).toMatch(/not a verdict/);
  });

  it('a file that yielded nothing is reported, not dropped', () =>
    expect(renderSweep(doc({ scope: { changed: 3, targets: 2, swept: 1, skipped: [{ file: 'src/b.ts', reason: 'no line in this file matches a fault producer' }] } })))
      .toMatch(/skipped src\/b\.ts/));

  it('always says the findings are proposals, never claims', () =>
    expect(renderSweep(doc())).toMatch(/PROPOSALS, not claims/));

  it('a clean sweep says how many were caught rather than nothing at all', () => {
    const text = renderSweep(doc({ counts: { killed: 2 }, findings: [], exitCode: 0 }));
    expect(text).toMatch(/No fault survived\. 2 of 2 probed faults were caught/);
  });

  it('nothing to propose is a sentence, not an empty report', () =>
    expect(renderSweep(doc({ scope: { changed: 3, targets: 0, swept: 0 } }))).toMatch(/Nothing to propose/));
});

const record = (over = {}) => ({
  claim: { id: 'A-FILE' },
  subject: { id: 'S1', file: 'src/a.ts', faultClass: 'field-dropped', description: 'Field dropped: `email` is no longer written.' },
  verdict: 'survived',
  detail: {},
  defenders: { requested: ['t.test.ts'], resolved: ['t.test.ts'], nocover: false },
  ...over,
});
const sig = [{ file: 't.test.ts', signal: 'persistence-payload-unasserted', reason: 'mocks @/lib/prisma; 3 argument-free call assertions in the file.' }];
const writeFault = { id: 'S1', line: 9, faultClass: 'field-dropped', find: '  data: { email },' };
const plainFault = { id: 'S1', line: 4, faultClass: 'statement-deleted', find: 'const x = 1;' };

describe('findingFrom — the engine decision, pure so a runner is not needed to falsify it', () => {
  it('a killed fault is not a finding', () =>
    expect(findingFrom(record({ verdict: 'killed' }), writeFault, () => sig)).toBeNull());

  it('a survivor on the write path carries the signal and its hint', () => {
    const f = findingFrom(record(), writeFault, () => sig);
    expect(f.writePath).toBe(true);
    expect(f.signals).toEqual(sig);
    expect(f.hint).toContain('data');
  });

  it('a survivor OFF the write path carries no signal, whatever the defenders look like', () => {
    const f = findingFrom(record(), plainFault, () => sig);
    expect(f.writePath).toBe(false);
    expect(f.signals).toBeUndefined();
  });

  it('a verdict other than survived never carries a signal, even on a write line', () => {
    for (const verdict of ['nocover', 'timeout', 'flaky-defender', 'unverifiable', 'fault-invalid']) {
      expect(findingFrom(record({ verdict }), writeFault, () => sig).signals).toBeUndefined();
    }
  });

  it('carries the reason when the probe stated one', () =>
    expect(findingFrom(record({ verdict: 'unverifiable', detail: { reason: 'anchor-missing' } }), plainFault).reason).toBe('anchor-missing'));
});

describe('gatingCount — what a sweep fails on', () => {
  it('is exactly survived and nocover', () => {
    expect([...GATING].sort()).toEqual(['nocover', 'survived']);
    const fs = ['survived', 'nocover', 'timeout', 'flaky-defender', 'unverifiable', 'fault-invalid'].map((verdict) => finding({ verdict }));
    expect(gatingCount(fs)).toBe(2);
  });

  it('a sweep of only unanchorable proposals gates on nothing', () =>
    expect(gatingCount([finding({ verdict: 'fault-invalid' }), finding({ verdict: 'unverifiable' })])).toBe(0));
});

describe('sortFindings — survivors first, write path before the rest', () => {
  it('orders by verdict, then the write path, then position', () => {
    const out = sortFindings([
      finding({ verdict: 'unverifiable', writePath: false, file: 'src/z.ts' }),
      finding({ verdict: 'survived', writePath: false, file: 'src/b.ts' }),
      finding({ verdict: 'nocover', writePath: false, file: 'src/a.ts' }),
      finding({ verdict: 'survived', writePath: true, file: 'src/c.ts' }),
    ]);
    expect(out.map((f) => [f.verdict, f.file])).toEqual([
      ['survived', 'src/c.ts'], ['survived', 'src/b.ts'], ['nocover', 'src/a.ts'], ['unverifiable', 'src/z.ts'],
    ]);
  });

  it('does not mutate its input', () => {
    const input = [finding({ verdict: 'nocover' }), finding({ verdict: 'survived' })];
    sortFindings(input);
    expect(input[0].verdict).toBe('nocover');
  });
});
