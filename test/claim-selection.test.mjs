// @req FR-16
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.mjs';
import { claimSelection, partialScope } from '../src/commands/probe.mjs';
import { selectClaims } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

describe('claim option semantics', () => {
  it('flattens repeated and comma-separated values in first-seen order and collapses duplicates', () => {
    expect(claimSelection(['B', 'A,B', ' C '])).toEqual(['B', 'A', 'C']);
    expect(claimSelection(undefined)).toBeUndefined();
    expect(claimSelection([' , '])).toEqual([]);
  });

  it('orders scoped claims by the request and rejects every unknown id together', () => {
    const claims = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    expect(selectClaims(claims, ['C', 'A'])).toEqual([{ id: 'C' }, { id: 'A' }]);
    expect(() => selectClaims(claims, [])).toThrow(/at least one claim id/);
    expect(() => selectClaims(claims, ['NOPE-1', 'NOPE-2'])).toThrow(/NOPE-1, NOPE-2/);
  });

  it('reports requested and probed scope without deriving one count from the other', () => {
    expect(partialScope(['A', 'B'], [{ claim: { id: 'A' } }, { claim: { id: 'A' } }])).toEqual({
      requestedClaims: ['A', 'B'],
      requestedCount: 2,
      probedClaims: ['A'],
      probedCount: 1,
    });
  });

  it('publishes partial probe scope as a validated status contract', () => {
    const doc = {
      schemaVersion: 1,
      tool: { name: 'testguard', version: '0.10.0' },
      generatedAt: '2026-09-19T22:00:00Z',
      state: 'unprobed',
      next: { action: 'probe', command: 'testguard probe', why: 'Claims have not been probed.' },
      counts: { claims: 2, faults: 2 },
      run: {
        id: 'run-20260919T220000',
        evidence: '.testguard/evidence-partial.json',
        provisional: false,
        records: 1,
        newSinceBaseline: 0,
        exitCode: 0,
        scope: { requestedClaims: ['A', 'B'], requestedCount: 2, probedClaims: ['A'], probedCount: 1 },
      },
    };
    expect(validate('status', doc).errors).toEqual([]);
    doc.run.scope.requestedCount = 1;
    expect(validate('status', doc).errors.map((error) => error.path)).toContain('/run/scope/requestedCount');
  });

  it('the global parser retains every repeated --claim occurrence', async () => {
    const { lines, io } = capture();
    expect(await main(['probe', '.', '--claim', 'NOPE-1', '--claim', 'NOPE-2', '--quiet'], io)).toBe(2);
    expect(lines.err.join('\n')).toContain('unknown claim id(s) NOPE-1, NOPE-2');
  });

  it('singular --claim commands reject repeated values before touching a file', async () => {
    const scaffold = capture();
    expect(await main(['scaffold', 'missing.mjs', '--claim', 'A', '--claim', 'B'], scaffold.io)).toBe(3);
    expect(scaffold.lines.err.join('\n')).toContain('scaffold accepts exactly one --claim <ID>');
    const admit = capture();
    expect(await main(['admit', 'missing.test.mjs', '--claim', 'A', '--claim', 'B'], admit.io)).toBe(3);
    expect(admit.lines.err.join('\n')).toContain('admit accepts exactly one --claim <ID>');
  });
});
