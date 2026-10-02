// @req FR-16
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.mjs';
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

});
