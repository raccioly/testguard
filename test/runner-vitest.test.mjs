// @req FR-10
// @req NFR-02
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { parseReport, runProcess, checkRunner, resolveRunner, runnerArgv, resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { argvFor as vitestArgv } from '../src/probe/runners/vitest.mjs';
import { argvFor as jestArgv } from '../src/probe/runners/jest.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const file = (status, tests, message) => ({ status, message, assertionResults: tests });
const t = (status, ...failureMessages) => ({ status, failureMessages });

describe('parseReport', () => {
  it('pass', () => {
    const { run } = parseReport({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, testResults: [file('passed', [t('passed'), t('passed')])] }, 10);
    expect(run).toEqual({ outcome: 'pass', tests: { total: 2, passed: 2, failed: 0 }, assertionFailures: 0, durationMs: 10 });
  });

  it('assertion failure counts toward killing', () => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [file('failed', [t('passed'), t('failed', 'AssertionError: expected 1 to be 2')])] }, 10);
    expect(run.outcome).toBe('fail');
    expect(run.assertionFailures).toBe(1);
    expect(timeouts).toBe(0);
  });

  it('a thrown exception in the test body also counts (it is neither timeout nor load failure)', () => {
    const { run } = parseReport({ success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [file('failed', [t('failed', 'TypeError: cannot read properties of undefined')])] }, 10);
    expect(run.assertionFailures).toBe(1);
  });

  it('timeout is separated from assertion failures', () => {
    const { run, timeouts } = parseReport({ success: false, numTotalTests: 2, numPassedTests: 0, numFailedTests: 2, testResults: [file('failed', [t('failed', 'Error: Test timed out in 1000ms.'), t('failed', 'AssertionError: x')])] }, 10);
    expect(run.assertionFailures).toBe(1);
    expect(timeouts).toBe(1);
  });

  it('finds the cause under jest\'s "Test suite failed to run" banner, so a syntax error is named', () => {
    const { run, loadMessage } = parseReport({ success: false, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [file('failed', [], '  ● Test suite failed to run\n\n    SyntaxError: /x/src/redact.js: missing ) after argument list (39:60)\n\n      37 |')] }, 10);
    expect(run.outcome).toBe('error');
    expect(loadMessage).toMatch(/^SyntaxError: .*missing \)/);
  });

  it('a file that failed to load is an error, not a fail', () => {
    const { run, loadMessage } = parseReport({ success: false, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [file('failed', [], 'Failed to parse source\nmore')] }, 10);
    expect(run.outcome).toBe('error');
    expect(loadMessage).toBe('Failed to parse source');
  });
});

describe('runVitest budget', () => {
  it('kills a process that exceeds the wall-clock budget and reports timeout', async () => {
    const { run } = await runProcess({ argv: () => [],  projectDir: process.cwd(), files: [], budgetMs: 300, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    expect(run.outcome).toBe('timeout');
  }, 5000);

  it('reports error when the command produces no report', async () => {
    const { run, loadMessage } = await runProcess({ argv: () => [],  projectDir: process.cwd(), files: [], budgetMs: 5000, command: [process.execPath, '-e', 'console.error("boom"); process.exit(1)'] });
    expect(run.outcome).toBe('error');
    expect(loadMessage).toBe('boom');
  });
});

describe('runner resolution: the project package first, PATH second, npx never', () => {
  it('resolves vitest from this project with its pinned version and its own bin script', async () => {
    resetRunnerCache();
    const r = await checkRunner({ projectDir: ROOT, pkg: 'vitest', bin: 'vitest' });
    const pinned = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')).version;
    expect(r).toEqual({ ok: true, version: pinned, source: 'project' });
    const argv = runnerArgv(ROOT, 'vitest', 'vitest');
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toMatch(/node_modules[\\/]vitest[\\/]vitest\.mjs$/);
    expect(resolveRunner({ projectDir: ROOT, pkg: 'vitest', bin: 'vitest' }).source).toBe('project');
  });

  it('a project without the package, and nothing on PATH, is not resolvable — whatever the npx cache holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-resolve-'));
    mkdirSync(join(dir, 'node_modules'));
    try {
      resetRunnerCache();
      const r = await checkRunner({ projectDir: dir, pkg: 'definitely-not-a-runner-xyz', bin: 'definitely-not-a-runner-xyz' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not installed in the project and `definitely-not-a-runner-xyz` is not on PATH/);
      expect(runnerArgv(dir, 'definitely-not-a-runner-xyz', 'definitely-not-a-runner-xyz')).toEqual(['definitely-not-a-runner-xyz']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetRunnerCache();
    }
  });

  it('falls back to an executable on PATH and says so (source: path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-resolve-path-'));
    const bin = mkdtempSync(join(tmpdir(), 'tg-resolve-bin-'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(bin, 'fakerunner'), '#!/bin/sh\necho 7.7.7\n', { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      resetRunnerCache();
      const r = await checkRunner({ projectDir: dir, pkg: 'fakerunner', bin: 'fakerunner' });
      expect(r).toEqual({ ok: true, version: '7.7.7', source: 'path' });
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      resetRunnerCache();
    }
  });
});

describe('each runner invokes the binary resolved for the project, not a bare name', () => {
  it('vitest: the command line starts with the resolved binary and asks for a JSON report at our path', () => {
    const argv = vitestArgv(ROOT, ['test/a.test.mjs'], '/tmp/out.json');
    expect(argv.slice(0, 2)).toEqual(runnerArgv(ROOT, 'vitest', 'vitest'));
    expect(argv[0]).toBe(process.execPath);            // the project's own binary, run with this node
    expect(argv).not.toContain('vitest');              // never a bare name for PATH to resolve
    expect(argv).toContain('--reporter=json');
    expect(argv).toContain('--outputFile=/tmp/out.json');
    expect(vitestArgv(ROOT, [], '/tmp/o.json', { serial: true })).toContain('--no-file-parallelism');
    expect(vitestArgv(ROOT, [], '/tmp/o.json')).not.toContain('--no-file-parallelism');
  });

  it('jest: same rule, plus exact paths rather than regexes', () => {
    const argv = jestArgv(ROOT, ['test/a.test.js'], '/tmp/out.json');
    expect(argv.slice(0, 2)).toEqual(runnerArgv(ROOT, 'jest', 'jest'));
    expect(argv).not.toContain('jest');
    expect(argv).toContain('--runTestsByPath');
    expect(argv).toContain('--ci');
    expect(jestArgv(ROOT, [], '/tmp/o.json', { serial: true })).toContain('--runInBand');
  });
});
