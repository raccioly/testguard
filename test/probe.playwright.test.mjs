import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { resetConfigCache } from '../src/probe/runners/playwright.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer-playwright');
// The fixture carries its own dependencies (@playwright/test + vitest) so the
// tool's package.json stays untouched. Without `npm ci` in the fixture this
// suite is skipped; CI's playwright job installs it.
const INSTALLED = existsSync(join(FIXTURE, 'node_modules', '@playwright', 'test')) && existsSync(join(FIXTURE, 'node_modules', 'vitest'));

/**
 * The mixed-defender acceptance test: vitest for `test/`, Playwright for
 * `e2e/`, one claim listing both. Same oracle discipline as the other
 * fixtures: every expectation in expected.json was verified by applying the
 * fault by hand.
 */
describe.skipIf(!INSTALLED)('probe reproduces the mixed vitest + Playwright fixture', () => {
  let scratch;
  let evidence;
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-playwright-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules|\.flake-counter|test-results/.test(src) });
    symlinkSync(join(FIXTURE, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => { const r = spawnSync('git', ['-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: scratch, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'fixture');
    resetConfigCache();
    evidence = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, mode: 'worktree', escalate: false, budgetMs: 60_000, toolVersion: 'test' });
  }, 600_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); resetConfigCache(); });

  it('yields every expected verdict, with the expected reason where one is stated', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }]));
    const wanted = Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));
    expect(actual).toEqual(wanted);
  });

  it('vitest stays the project runner; playwright is recorded as a second runner with its version', () => {
    expect(evidence.run.runner.name).toBe('vitest');
    expect(evidence.run.runners.map((r) => r.name).sort()).toEqual(['playwright', 'vitest']);
    expect(evidence.run.runners.find((r) => r.name === 'playwright').version).toMatch(/^\d+\.\d+/);
  });

  it('the mixed claim says which file ran under which runner; single-runner claims carry no byRunner', () => {
    const mixed = evidence.records.find((r) => r.claim.id === 'TOGGLE-003');
    expect(mixed.defenders.byRunner).toEqual({ vitest: ['test/toggle.test.mjs'], playwright: ['e2e/toggle.spec.mjs'] });
    expect(mixed.detail.probeRuns[0].tests.total).toBe(3); // 1 vitest test + 2 playwright specs, merged
    expect(evidence.records.find((r) => r.claim.id === 'TOGGLE-001').defenders.byRunner).toBeUndefined();
    expect(evidence.records.find((r) => r.claim.id === 'TOGGLE-002').defenders.byRunner).toBeUndefined();
  });

  it('a playwright `flaky` status is a non-green baseline, and `timedOut` is a timeout with no assertion failure', () => {
    const flaky = evidence.records.find((r) => r.claim.id === 'FLAKY-PW');
    expect(flaky.detail.baselineRuns[0]).toMatchObject({ outcome: 'fail', assertionFailures: 0 });
    const t = evidence.records.find((r) => r.claim.id === 'TOGGLE-005');
    expect(t.detail.baselineRuns.every((b) => b.outcome === 'pass')).toBe(true);
    expect(t.detail.probeRuns[0]).toMatchObject({ outcome: 'fail', assertionFailures: 0 });
  });

  it('emits evidence that conforms', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });
});
