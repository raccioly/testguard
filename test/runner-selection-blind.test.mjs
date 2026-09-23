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

describe('selectRunner — a runner that sees no test file is not an answer', () => {
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

  it('says so plainly when nothing matched a test file, instead of letting every verdict read as a finding', async () => {
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
    if (!sel.error) {
      expect(sel.testFiles).toBe(0);
      expect(sel.warning).toMatch(/no runner matched a test file/);
      expect(sel.warning).toMatch(/every verdict will be nocover/);
    } else {
      // Equally acceptable: nothing resolved at all, which is already explicit.
      expect(sel.error).toMatch(/vitest|jest|python/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('an explicitly named runner is still honoured, and reports what it can see', async () => {
    // The caller asked for it. Overriding that would be the tool deciding it
    // knows better than the person who typed --runner.
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', devDependencies: { vitest: '*' } }),
      'src/a.mjs': 'export const a = 1;\n',
    });
    const sel = await selectRunner({ projectDir: dir, name: 'vitest' });
    if (!sel.error) {
      expect(sel.runner.name).toBe('vitest');
      expect(sel.testFiles).toBe(0);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
