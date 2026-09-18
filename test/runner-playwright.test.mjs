// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as playwright from '../src/probe/runners/playwright.mjs';
import * as vitest from '../src/probe/runners/vitest.mjs';
import { partitionByRunner, runnerFor, mergeRuns, RUNNERS, OWNED_RUNNERS } from '../src/probe/runners/index.mjs';
import { classify } from '../src/probe/classify.mjs';
import { probe } from '../src/probe/probe.mjs';
import { runProcess } from '../src/probe/runners/shared.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, symlinkSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = JSON.parse(readFileSync(join(ROOT, 'test', 'samples', 'playwright-report.json'), 'utf8'));

/** A copy of the sample with only the suites whose file matches. */
const only = (...files) => ({ ...SAMPLE, suites: SAMPLE.suites.filter((s) => files.includes(s.file)) });

describe('playwright.parseReport — a real 1.63 JSON report, every status', () => {
  it('maps expected → pass', () => {
    const r = playwright.parseReport(only('toggle.spec.mjs'), 100);
    expect(r.run).toEqual({ outcome: 'pass', tests: { total: 2, passed: 2, failed: 0 }, assertionFailures: 0, durationMs: 100 });
    expect(r.timeouts).toBe(0);
    expect(r.failedTests).toEqual([]);
  });

  it('a flaky test (failed, then passed on retry) is NOT a green run: failed, no assertion failure, no timeout', () => {
    const r = playwright.parseReport(only('flaky.spec.mjs'), 100);
    expect(r.run.outcome).toBe('fail');
    expect(r.run.tests).toEqual({ total: 1, passed: 0, failed: 1 });
    expect(r.run.assertionFailures).toBe(0);
    expect(r.timeouts).toBe(0);
    expect(r.flaky).toBe(1);
    expect(r.failedTests).toEqual(['flaky.spec.mjs::is flaky by design']);
    // and through the verdict function: a flaky baseline can never be green → flaky-defender
    expect(classify({ defenders: ['e2e/flaky.spec.mjs'], anchor: { status: 'ok' }, baselineRuns: [r.run, r.run, r.run], probeRuns: [], confirmRuns: 3 })).toEqual({ verdict: 'flaky-defender', reason: 'defenders-not-green' });
  });

  it('unexpected/failed counts toward assertionFailures; unexpected/timedOut counts toward timeouts, never a kill; skipped is neither', () => {
    const r = playwright.parseReport(only('tmp-sample.spec.mjs'), 100);
    expect(r.run.tests).toEqual({ total: 3, passed: 0, failed: 2 });
    expect(r.run.assertionFailures).toBe(1);
    expect(r.timeouts).toBe(1);
    expect(r.failedTests.sort()).toEqual(['tmp-sample.spec.mjs::fails outright', 'tmp-sample.spec.mjs::times out']);
    const green = { outcome: 'pass', tests: { total: 3, passed: 3, failed: 0 }, assertionFailures: 0, durationMs: 1 };
    const timeoutOnly = { ...r.run, assertionFailures: 0 };
    expect(classify({ defenders: ['x'], anchor: { status: 'ok' }, baselineRuns: [green, green, green], probeRuns: [{ ...timeoutOnly, timeouts: 1 }], confirmRuns: 3 })).toEqual({ verdict: 'timeout', reason: 'test-timed-out' });
  });

  it('the whole sample: outcome fail, counts add up, ids are file::title', () => {
    const r = playwright.parseReport(SAMPLE, 1837);
    expect(r.run.tests).toEqual({ total: 6, passed: 2, failed: 3 });
    expect(r.run.assertionFailures).toBe(1);
    expect(r.timeouts).toBe(1);
    expect(r.flaky).toBe(1);
  });

  it('no tests, or a global error, is a load error with the informative line', () => {
    expect(playwright.parseReport({ suites: [], errors: [], stats: {} }, 5).run.outcome).toBe('error');
    const r = playwright.parseReport({ suites: [], errors: [{ message: 'Error: Cannot find module "./missing"\n    at file.mjs:1' }], stats: {} }, 5);
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/Cannot find module/);
  });
});

describe('playwright config, ownership and per-file runner selection', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); playwright.resetConfigCache(); });
  const project = (config) => {
    dir = mkdtempSync(join(tmpdir(), 'tg-pw-'));
    if (config !== null) writeFileSync(join(dir, config.name), config.text);
    for (const f of ['e2e/a.spec.ts', 'e2e/deep/b.test.mjs', 'test/unit.test.mjs', 'src/x.spec.js', 'e2e/helper.mjs']) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
    return dir;
  };

  it('reads testDir from a TypeScript config as text and owns only spec/test files under it', () => {
    project({ name: 'playwright.config.ts', text: "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './e2e', retries: 1 });\n" });
    expect(playwright.loadConfig(dir)).toEqual({ path: 'playwright.config.ts', testDir: 'e2e' });
    expect(playwright.owns(dir, 'e2e/a.spec.ts')).toBe(true);
    expect(playwright.owns(dir, 'e2e/deep/b.test.mjs')).toBe(true);
    expect(playwright.owns(dir, 'e2e/helper.mjs')).toBe(false); // not a spec
    expect(playwright.owns(dir, 'test/unit.test.mjs')).toBe(false);
    expect(playwright.owns(dir, 'src/x.spec.js')).toBe(false);
    expect(playwright.tests(dir)).toEqual(['e2e/a.spec.ts', 'e2e/deep/b.test.mjs']);
  });

  it('with no config nothing is owned and check() says so; without testDir the whole project is the test dir', async () => {
    project(null);
    expect(playwright.loadConfig(dir)).toBeNull();
    expect(playwright.owns(dir, 'e2e/a.spec.ts')).toBe(false);
    expect(await playwright.check({ projectDir: dir })).toEqual({ ok: false, message: 'no playwright.config.* in the project' });
    rmSync(dir, { recursive: true, force: true }); playwright.resetConfigCache();
    project({ name: 'playwright.config.mjs', text: 'export default { retries: 0 };\n' });
    expect(playwright.loadConfig(dir).testDir).toBe('.');
    expect(playwright.owns(dir, 'src/x.spec.js')).toBe(true);
  });

  it('partitionByRunner sends owned files to playwright and the rest to the project runner; runnerFor agrees', () => {
    project({ name: 'playwright.config.js', text: "module.exports = { testDir: 'e2e' };\n" });
    const groups = partitionByRunner(dir, ['test/unit.test.mjs', 'e2e/a.spec.ts', 'src/x.spec.js'], vitest);
    expect([...groups].map(([r, files]) => [r.name, files])).toEqual([['vitest', ['test/unit.test.mjs', 'src/x.spec.js']], ['playwright', ['e2e/a.spec.ts']]]);
    expect(runnerFor(dir, 'e2e/a.spec.ts', vitest).name).toBe('playwright');
    expect(runnerFor(dir, 'test/unit.test.mjs', vitest).name).toBe('vitest');
    // only owned files → the primary group is dropped, not left empty
    expect([...partitionByRunner(dir, ['e2e/a.spec.ts'], vitest).keys()].map((r) => r.name)).toEqual(['playwright']);
    // playwright as the project runner owns everything it matches
    expect([...partitionByRunner(dir, ['e2e/a.spec.ts'], playwright).keys()].map((r) => r.name)).toEqual(['playwright']);
    expect(RUNNERS.playwright).toBe(playwright);
    expect(OWNED_RUNNERS).toEqual([playwright]);
  });
});

describe('mergeRuns is pessimistic', () => {
  const run = (outcome, extra = {}) => ({ run: { outcome, tests: { total: 1, passed: outcome === 'pass' ? 1 : 0, failed: outcome === 'fail' ? 1 : 0 }, assertionFailures: outcome === 'fail' ? 1 : 0, durationMs: 10 }, timeouts: 0, failedTests: outcome === 'fail' ? ['f'] : [], ...extra });
  it('any error → error; any timeout → timeout; any failure → failure; counts add', () => {
    expect(mergeRuns([run('pass'), run('error', { loadMessage: 'boom' })]).run.outcome).toBe('error');
    expect(mergeRuns([run('pass'), run('error', { loadMessage: 'boom' })]).loadMessage).toBe('boom');
    expect(mergeRuns([run('fail'), run('timeout', { timeouts: 1 })]).run.outcome).toBe('timeout');
    const m = mergeRuns([run('pass'), run('fail')]);
    expect(m.run).toEqual({ outcome: 'fail', tests: { total: 2, passed: 1, failed: 1 }, assertionFailures: 1, durationMs: 20 });
    expect(m.failedTests).toEqual(['f']);
    expect(mergeRuns([run('pass'), run('pass')]).run.outcome).toBe('pass');
    const one = run('pass');
    expect(mergeRuns([one])).toBe(one); // a single part is returned as-is
  });
});

describe('an owned defender whose runner is not resolvable', () => {
  it('is a precondition failure naming the file and the runner, never a verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pw-missing-'));
    try {
      cpSync(join(ROOT, 'fixtures', 'known-answer'), dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir'); // vitest, no @playwright/test
      writeFileSync(join(dir, 'playwright.config.mjs'), "export default { testDir: './e2e' };\n");
      mkdirSync(join(dir, 'e2e'));
      writeFileSync(join(dir, 'e2e', 'redact.spec.mjs'), "import { test, expect } from '@playwright/test';\ntest('x', () => expect(1).toBe(1));\n");
      const claims = JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
      claims.claims = [{ ...claims.claims[0], defendedBy: ['e2e/redact.spec.mjs'] }];
      writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
      const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir });
      g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'x');
      playwright.resetConfigCache();
      // The project's node_modules has vitest but no @playwright/test. A global
      // `playwright` on PATH or in the npx cache must not count: the check
      // resolves the package from the project, never the binary from PATH.
      expect(await playwright.check({ projectDir: dir })).toEqual({ ok: false, message: expect.stringMatching(/@playwright\/test is not installed/) });
      await expect(probe({ projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, mode: 'worktree', escalate: false, budgetMs: 30_000, toolVersion: 't' }))
        .rejects.toThrow(/e2e\/redact\.spec\.mjs is a playwright test .* playwright is not resolvable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      playwright.resetConfigCache();
    }
  }, 120_000);
});

describe('runProcess for a runner that names its report through the environment', () => {
  it('substitutes {out} into the env values, so the report is found and parsed with the runner\'s parser', async () => {
    const script = 'require("fs").writeFileSync(process.env.REPORT_PATH, JSON.stringify({ suites: [], errors: [{ message: "Error: boom from env" }], stats: {} }))';
    const r = await runProcess({ projectDir: ROOT, files: [], budgetMs: 30_000, env: { REPORT_PATH: '{out}' }, parse: playwright.parseReport, argv: () => ['node', '-e', script] });
    expect(r.run.outcome).toBe('error');
    expect(r.loadMessage).toMatch(/boom from env/); // came through the file the env named, parsed by playwright's parser
  }, 60_000);
});
