import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRunner } from '../src/probe/runners/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-runner-sel-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try { symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir'); } catch {}
  return dir;
};

describe('selectRunner — native discovery is a precondition, not a guess', () => {
  it('auto prefers a resolvable runner that can actually see tests', () => {
    // A project with vitest available and real test files: unchanged behaviour,
    // now reporting how many files the choice can see.
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*' } }),
      'src/a.mjs': 'export const a = 1;\n',
      'test/a.test.mjs': "import { expect, it } from 'vitest';\nit('a', () => expect(1).toBe(1));\n",
    });
    return selectRunner({ projectDir: dir, name: 'auto' }).then((sel) => {
      expect(sel.error).toBeUndefined();
      expect(sel.runner.name).toBe('vitest');
      expect(sel.testFiles).toBeGreaterThan(0);
      expect(sel.warning).toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it('recomputes a live whole-command allowance before each runner subprocess', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*' } }),
      'test/a.test.mjs': "import { it } from 'vitest';\nit('a', () => {});\n",
    });
    const allowances = [30_000, 29_000];
    const requested = [];
    const sel = await selectRunner({
      projectDir: dir,
      name: 'auto',
      budgetFor: () => {
        const allowance = allowances[requested.length] ?? 28_000;
        requested.push(allowance);
        return allowance;
      },
    });
    expect(sel.error).toBeUndefined();
    expect(sel.runner.name).toBe('vitest');
    expect(requested).toEqual([30_000, 29_000]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when no resolvable runner discovers a test file', async () => {
    // THE REGRESSION. A pure TypeScript project on Playwright resolves neither
    // vitest nor jest; `auto` then reaches python — which resolves wherever a
    // python3 exists — globs for .py, finds none, and reports every fault as
    // `nocover`: a damning statement about the project, produced by a runner
    // that could not have seen its tests.
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '*' } }),
      'src/a.ts': 'export const a = 1;\n',
      // Deliberately NOT *.test.* or *.spec.*: those match vitest's own globs,
      // and the shape being reproduced is a suite no JS runner's glob can see.
      // Playwright finds it by testDir, which `auto` never selects.
      'e2e/a.pw.ts': "import { test } from '@playwright/test';\ntest('a', async () => {});\n",
    });
    const sel = await selectRunner({ projectDir: dir, name: 'auto' });
    expect(sel.runner).toBeUndefined();
    expect(sel.error).toMatch(/no test files|matched no test files|discovered no test files/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an explicitly named runner with an empty universe fails closed', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*' } }),
      'vitest.config.mjs': 'export default { test: { passWithNoTests: true } };\n',
      'src/a.mjs': 'export const a = 1;\n',
    });
    const sel = await selectRunner({ projectDir: dir, name: 'vitest' });
    expect(sel.runner).toBeUndefined();
    expect(sel.error).toMatch(/vitest.*no test files/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto continues after a successful empty discovery and selects the next non-empty runner', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*', jest: '*' } }),
      'vitest.config.mjs': "export default { test: { include: ['never/**/*.test.js'], passWithNoTests: true } };\n",
      'jest.config.mjs': "export default { testMatch: ['<rootDir>/checks/**/*.case.js'] };\n",
      'checks/a.case.js': "test('a', () => {});\n",
    });
    const sel = await selectRunner({ projectDir: dir, name: 'auto' });
    expect(sel.error).toBeUndefined();
    expect(sel.runner.name).toBe('jest');
    expect(sel.manifest.files).toEqual(['checks/a.case.js']);
    expect(Object.isFrozen(sel.manifest)).toBe(true);
    expect(Object.isFrozen(sel.manifest.files)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a resolved runner discovery failure stops auto instead of falling through', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*', jest: '*' } }),
      'vitest.config.mjs': "throw new Error('sentinel discovery config failure');\n",
      'test/a.test.js': "test('a', () => {});\n",
    });
    const sel = await selectRunner({ projectDir: dir, name: 'auto' });
    expect(sel.runner).toBeUndefined();
    expect(sel.error).toMatch(/vitest.*discovery.*sentinel discovery config failure/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not mistake an incidental Jest on PATH for a runner configured in a pure Python project', async () => {
    const dir = project({ 'tests/test_a.py': 'def test_a():\n    assert True\n' });
    const sel = await selectRunner({ projectDir: dir, name: 'auto' });
    expect(sel.error).toBeUndefined();
    expect(sel.runner.name).toBe('python');
    expect(sel.manifest.files).toEqual(['tests/test_a.py']);
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});
