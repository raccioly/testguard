// @req FR-16
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.mjs';
import { claimSelection, partialScope } from '../src/commands/probe.mjs';
import { selectClaims } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

describe('claim option semantics', () => {
  it('only an explicit empty-adoption request succeeds, without overwriting existing evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-empty-adoption-'));
    try {
      writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }));
      mkdirSync(join(dir, '.testguard'));
      const evidence = join(dir, '.testguard', 'evidence.json');
      writeFileSync(evidence, 'existing evidence must remain untouched');
      const strict = capture();
      expect(await main(['probe', dir], strict.io)).toBe(2);
      const allowed = capture();
      expect(await main(['probe', dir, '--allow-empty', '--json'], allowed.io)).toBe(0);
      expect(allowed.lines.err.join('\n')).toMatch(/verification skipped/);
      const doc = JSON.parse(allowed.lines.out.join('\n'));
      expect(validate('status', doc).errors).toEqual([]);
      expect(doc).toMatchObject({ state: 'no-claims', counts: { claims: 0, faults: 0 } });
      expect(doc.run).toBeUndefined();
      const status = capture();
      expect(await main(['status', dir, '--json'], status.io)).toBe(2);
      expect(JSON.parse(status.lines.out.join('\n')).state).toBe('no-claims');
      expect(readFileSync(evidence, 'utf8')).toBe('existing evidence must remain untouched');
      expect(await main(['probe', dir, '--allow-empty', '--claim', 'MISSING'], capture().io)).toBe(2);
      writeFileSync(join(dir, 'testguard.claims.json'), '{"schemaVersion":1,"claims":"invalid"}');
      expect(await main(['probe', dir, '--allow-empty'], capture().io)).toBe(2);
      rmSync(join(dir, 'testguard.claims.json'));
      expect(await main(['probe', dir, '--allow-empty'], capture().io)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    const allowed = capture();
    expect(await main(['probe', '.', '--allow-empty', '--claim', 'NOPE-1'], allowed.io)).toBe(2);
    expect(allowed.lines.err.join('\n')).toContain('unknown claim id(s) NOPE-1');
  });

  it('command help shows only that command options and handles global and unknown help honestly', async () => {
    for (const [command, option] of [['replay', '--since'], ['gate', '--strict'], ['scaffold', '--out'], ['probe', '--allow-empty'], ['concerns', '--concerns']]) {
      const c = capture();
      expect(await main([command, '--help'], c.io)).toBe(0);
      const help = c.lines.out.join('\n');
      expect(help).toContain(`testguard ${command}`);
      expect(help).toContain(option);
      expect(help).toContain('Example:');
      if (command !== 'probe') expect(help).not.toContain('--node-modules');
      if (command !== 'replay') expect(help).not.toContain('--since <range>');
    }
    const global = capture();
    expect(await main(['--help'], global.io)).toBe(0);
    expect(global.lines.out.join('\n')).toContain("<command> --help");
    expect(await main(['unknown', '--help'], capture().io)).toBe(3);
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
