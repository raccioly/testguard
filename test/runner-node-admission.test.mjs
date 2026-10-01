// @req FR-10
// Focused admission defenders; runner-node.test.mjs retains runtime acceptance.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check, run } from '../src/probe/runners/node-test.mjs';
import { selectRunner } from '../src/probe/runners/index.mjs';

const dirs = [];
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-node-admission-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'test/a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('real', () => assert.equal(2+2,4));\n");
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('native Node admission', () => {
  it('runs without node_modules and records the actual built-in runtime', async () => {
    expect(await check()).toEqual({ ok: true, version: process.versions.node, source: 'builtin' });
    const dir = project();
    const selected = await selectRunner({ projectDir: dir, name: 'node-test' });
    expect(selected.runner.name).toBe('node-test'); expect(selected.testFiles).toBe(1);
    expect((await run({ projectDir: dir, files: ['test/a.test.mjs'], budgetMs: 4000 })).run.outcome).toBe('pass');
  });
  it('refuses non-default loading and never silently routes a Node project through auto', async () => {
    const original = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = '--import=unsupported';
    try { expect((await check()).ok).toBe(false); } finally { if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original; }
    const selected = await selectRunner({ projectDir: project(), name: 'auto', budgetMs: 2000 });
    expect(selected.runner?.name).not.toBe('node-test');
  });
});
