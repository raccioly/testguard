import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommandTemplate, expandCommand, checkBinary, parseReport } from '../src/probe/runners/shared.mjs';

describe('parseCommandTemplate / expandCommand', () => {
  it('splits words, honours quotes, and substitutes {files} and {out}', () => {
    const words = parseCommandTemplate('pnpm --filter "my app" vitest run {files} --reporter=json --outputFile={out}');
    expect(words).toEqual(['pnpm', '--filter', 'my app', 'vitest', 'run', '{files}', '--reporter=json', '--outputFile={out}']);
    expect(expandCommand(words, ['a.test.ts', 'b.test.ts'], '/tmp/r.json')).toEqual(['pnpm', '--filter', 'my app', 'vitest', 'run', 'a.test.ts', 'b.test.ts', '--reporter=json', '--outputFile=/tmp/r.json']);
  });
  it('expands {out} embedded in a word or standing alone', () => {
    expect(expandCommand(parseCommandTemplate('vitest run {files} --outputFile {out}'), ['t.mjs'], '/tmp/r.json')).toEqual(['vitest', 'run', 't.mjs', '--outputFile', '/tmp/r.json']);
  });
  it('rejects a template missing the placeholders or with an open quote', () => {
    expect(() => parseCommandTemplate('vitest run {files}')).toThrow(/\{out\}/);
    expect(() => parseCommandTemplate('vitest "run {files} {out}')).toThrow(/quote/);
  });
});

describe('a report of the wrong shape says so', () => {
  it('a pytest-json-report document is an error that names the mismatch, not a suite with zero tests', () => {
    // The verdict was always safe — a non-green baseline makes the claim
    // unverifiable rather than green — but `defenders-failed-to-load` with no
    // message told the user nothing about why.
    const { run, loadMessage } = parseReport({ created: 1, exitcode: 1, tests: [{ nodeid: 'a::b', outcome: 'failed' }], summary: { total: 1, failed: 1 } }, 12);
    expect(run.outcome).toBe('error');
    expect(run.assertionFailures).toBe(0);
    expect(loadMessage).toMatch(/no `testResults` array/);
  });

  it('a genuinely empty jest report is still just empty', () => {
    expect(parseReport({ testResults: [], numTotalTests: 0 }, 1).loadMessage).toBeUndefined();
  });
});

describe('checkRunner', () => {
  it('reports the runner unresolvable when nothing on PATH can provide it (and does not crash when npx itself is missing)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tg-norunner-'));
    const r = await checkBinary({ projectDir: empty, bin: 'vitest', budgetMs: 30_000, env: { PATH: empty } });
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
  }, 40_000);
  it('finds vitest from this repository', async () => {
    const r = await checkBinary({ projectDir: process.cwd(), bin: 'vitest', budgetMs: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
  }, 40_000);
});
