import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');

/**
 * The acceptance test. A copy of the fixture becomes its own git repository
 * so the run never depends on this repo's git state, then `probe` runs in
 * worktree mode and must reproduce expected.json exactly.
 */
describe('probe reproduces the known-answer fixture', () => {
  let scratch;
  let evidence;
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-fixture-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules|\.flake-counter/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: scratch, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');

    evidence = await probe({
      projectDir: scratch,
      claims: loadClaims(join(scratch, 'testguard.claims.json')),
      confirmRuns: expected.confirmRuns,
      mode: 'worktree',
      budgetMs: 30_000,
      toolVersion: 'test',
    });
  }, 180_000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('yields every expected verdict, with the expected reason where one is stated', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }]));
    const wanted = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));
    expect(actual).toEqual(wanted);
  });

  it('emits evidence that conforms to the spec', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });

  it('ran in a scratch worktree and left the source tree untouched', () => {
    expect(evidence.run.mode).toBe('worktree');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf8' }).stdout;
    expect(status).toBe('');
    expect(existsSync(join(scratch, '.testguard'))).toBe(false);
  });

  it('records N/N baseline and probe runs for killed and survived', () => {
    for (const r of evidence.records.filter((x) => x.verdict === 'killed' || x.verdict === 'survived')) {
      expect(r.detail.baselineRuns).toHaveLength(expected.confirmRuns);
      expect(r.detail.probeRuns).toHaveLength(expected.confirmRuns);
    }
  });

  it('escalated the survivors to the whole suite; the flaky test there did not get the credit', () => {
    const survivors = evidence.records.filter((x) => x.verdict === 'survived');
    expect(survivors).toHaveLength(2);
    for (const r of survivors) {
      expect(r.detail.escalated).toBe(true);
      expect(r.detail.reason).toBeUndefined();
      // flaky.test.mjs fails on alternate runs, so the intersection only empties on the 2nd run
      expect(r.detail.escalationRuns.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('ranks the critical survivor above the high one', () => {
    const by = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.rank.score]));
    expect(by['REDACT-001/F1']).toBeGreaterThan(by['REDACT-003/F1']);
  });
});
