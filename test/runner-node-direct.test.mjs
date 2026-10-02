// @req FR-10
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { argvFor, parseReport, run, supportsSingleProcess } from '../src/probe/runners/node-test.mjs';
import { runProcess } from '../src/probe/runners/shared.mjs';

const dirs = [];
const body = (code) => `import { test, describe, beforeEach, afterEach } from 'node:test'; import assert from 'node:assert/strict';\n${code}\n`;
const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-node-direct-')); dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), source);
  }
  return dir;
};
const execute = (dir, extra = {}) => run({ projectDir: dir, files: ['test/a.test.mjs'], budgetMs: 4000, ...extra });
const reference = (dir) => {
  const entries = join(dir, 'reference-entries.json');
  writeFileSync(entries, '{"entries":[');
  return runProcess({ projectDir: dir, files: ['test/a.test.mjs'], budgetMs: 4000,
    cleanupOnClose: true, argv: (files) => argvFor(dir, files), parse: parseReport,
    env: { TESTGUARD_NODE_ENTRIES: entries, TESTGUARD_NODE_REPORT: '{out}', TESTGUARD_NODE_WORKERS: '1', TESTGUARD_NODE_COLLECT: '0', NODE_TEST_CONTEXT: '', NODE_DISABLE_COMPILE_CACHE: '1' } });
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('admits only supported API versions, with existing execution for older and unknown families', () => {
  for (const version of ['22.8.0', '22.23.2', '24.0.0', '24.18.0', '26.0.0']) expect(supportsSingleProcess(version)).toBe(true);
  for (const version of ['20.0.0', '20.20.2', '22.7.0', '23.0.0', '25.0.0', '27.0.0', 'bad']) expect(supportsSingleProcess(version)).toBe(false);
});

describe.skipIf(!supportsSingleProcess())('fresh single-process native confirmations', () => {
  it('preserves ordinary failures beside .only declarations and suite ancestry', async () => {
    const dir = project({ 'test/a.test.mjs': body("test.only('focused',()=>assert.equal(1,1));test('worker context',()=>assert.match(process.env.NODE_TEST_CONTEXT??'',/^child/));describe('suite',()=>{test('ordinary',()=>assert.equal(1,2));});") });
    const before = await reference(dir); const after = await execute(dir);
    expect(after.run.outcome).toBe('fail'); expect(after.run.assertionFailures).toBe(1);
    expect(after.run.tests).toEqual(before.run.tests); expect(after.failedTests).toEqual(before.failedTests);
  });
  it('refuses top-level import errors even after passing or failing tests were registered', async () => {
    for (const value of [1, 2]) {
      const dir = project({ 'test/a.test.mjs': body(`test('registered',()=>assert.equal(1,${value}));throw new Error('IMPORT_AFTER_REGISTRATION');`) });
      const result = await execute(dir);
      expect(result.run.outcome).toBe('error'); expect(result.run.assertionFailures).toBe(0);
    }
  });
  it('refuses late exceptions and rejections beside completed assertion failures', async () => {
    for (const failure of ["throw new Error('LATE')", "Promise.reject(new Error('LATE'))"]) {
      const dir = project({ 'test/a.test.mjs': body(`test('red',()=>{setTimeout(()=>{${failure}},30);assert.equal(1,2);});`) });
      const result = await execute(dir);
      expect(result.run.outcome).toBe('error'); expect(result.run.assertionFailures).toBe(0);
    }
  });
  it('keeps hooks, syntax errors, early exits and skipped-only files unproven', async () => {
    for (const code of ["beforeEach(()=>{throw new Error('HOOK');});test('body',()=>assert.equal(1,2));", "test('exit',()=>process.exit(0));", "test.skip('skip',()=>assert.equal(1,2));", "("]) {
      const dir = project({ 'test/a.test.mjs': body(code) });
      const result = await execute(dir);
      expect(result.run.outcome).toBe('error'); expect(result.run.assertionFailures).toBe(0);
    }
  });
  it('executes every confirmation with a new PID, fresh globals and live source bytes', async () => {
    const dir = project({ 'src/value.mjs': 'export const value=1;', 'test/a.test.mjs': body("import {appendFileSync} from 'node:fs';import {value} from '../src/value.mjs';test('fresh',()=>{assert.equal(globalThis.previous,undefined);globalThis.previous=true;appendFileSync('pids.txt',process.pid+'\\n');assert.equal(value,1);});") });
    expect((await execute(dir)).run.outcome).toBe('pass');
    expect((await execute(dir)).run.outcome).toBe('pass');
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value=2;');
    expect((await execute(dir)).run.assertionFailures).toBe(1);
    const pids = readFileSync(join(dir,'pids.txt'),'utf8').trim().split('\n');
    expect(pids).toHaveLength(3); expect(new Set(pids).size).toBe(3);
  });
  it('retains the deadline after the result stream completes', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('green',()=>{setInterval(()=>{},1000);assert.equal(1,1);});") });
    const result = await execute(dir, { budgetMs: 500 });
    expect(result.run.outcome).toBe('timeout'); expect(result.run.assertionFailures).toBe(0);
  });
  it('keeps separate workers for multiple selected entry files', async () => {
    const source = body("test('fresh global',()=>{assert.equal(globalThis.previous,undefined);globalThis.previous=true;});");
    const dir = project({ 'test/a.test.mjs': source, 'test/b.test.mjs': source });
    const result = await execute(dir, { files: ['test/a.test.mjs','test/b.test.mjs'], workers: 2 });
    expect(result.run.outcome).toBe('pass'); expect(result.run.tests.total).toBe(2);
  });
});
