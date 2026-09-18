// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { selectRunner } from '../src/probe/runners/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer-jest');

/** The jest edition of the acceptance test: the same oracle, a different runner. */
describe('probe reproduces the known-answer fixture with jest', () => {
  let scratch;
  let evidence;
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-jest-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules|\.flake-counter/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => { const r = spawnSync('git', ['-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: scratch, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'fixture');
    evidence = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, mode: 'worktree', runnerName: 'jest', escalate: false, budgetMs: 60_000, toolVersion: 'test' });
  }, 300_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('selects jest explicitly and records it', () => {
    expect(evidence.run.runner.name).toBe('jest');
    expect(evidence.run.runner.version).toMatch(/^\d+\./);
  });

  it('yields every expected verdict, with the expected reason where one is stated', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }]));
    const wanted = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));
    expect(actual).toEqual(wanted);
  });

  it('emits evidence that conforms', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });

  it('auto-selects vitest before jest when both resolve, and jest when only jest is asked for', async () => {
    expect((await selectRunner({ projectDir: ROOT, name: 'auto' })).runner.name).toBe('vitest');
    expect((await selectRunner({ projectDir: ROOT, name: 'jest' })).runner.name).toBe('jest');
    expect((await selectRunner({ projectDir: ROOT, name: 'mocha' })).error).toMatch(/unknown runner/);
  }, 60_000);
});
