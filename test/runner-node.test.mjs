// @req FR-10
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { run, discoverTests, check } from '../src/probe/runners/node-test.mjs';
import { selectRunner } from '../src/probe/runners/index.mjs';

const owned = [];
const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-node-test-')); owned.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), source);
  }
  return dir;
};
const body = (code) => `import { test } from 'node:test'; import assert from 'node:assert/strict';\n${code}\n`;
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const execute = (dir, files = ['test/a.test.mjs'], extra = {}) => run({ projectDir: dir, files, budgetMs: 4000, ...extra });
const discover = (dir, extra = {}) => discoverTests({ projectDir: dir, version: process.versions.node, ...extra });
const alive = (pid) => {
  try { process.kill(pid,0);return process.platform==='win32'||!execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1000}).trim().startsWith('Z'); } catch {return false;}
};

describe('native Node admission, collection and execution', () => {
  it('runs without node_modules and records the actual built-in runtime', async () => {
    expect(await check()).toEqual({ ok: true, version: process.versions.node, source: 'builtin' });
    const dir = project({ 'test/a.test.mjs': body("test('real', () => assert.equal(2+2,4));") });
    const selected = await selectRunner({ projectDir: dir, name: 'node-test' });
    expect(selected.runner.name).toBe('node-test'); expect(selected.testFiles).toBe(1);
    expect((await execute(dir)).run.outcome).toBe('pass');
  });

  it('refuses an explicitly selected empty universe', async () => {
    const selected = await selectRunner({ projectDir: project({}), name: 'node-test' });
    expect(selected.error).toMatch(/no test files/);
  });
  it('does not turn a top-level assertion or syntax/import error into a test-body kill', async () => {
    for (const source of ["import assert from 'node:assert/strict'; assert.equal(1,2);", '(', "import './missing.mjs';"]) {
      const dir = project({ 'test/a.test.mjs': source });
      const result = await execute(dir);
      expect(result.run.outcome).toBe('error'); expect(result.run.assertionFailures).toBe(0);
      await expect(discover(dir)).rejects.toThrow();
    }
  });
  it('detects a genuine test-body exception and preserves its test identity', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('exception', () => { throw new Error('bad behavior'); });") });
    const result = await execute(dir);
    expect(result.run.outcome).toBe('fail'); expect(result.run.assertionFailures).toBe(1);
    expect(result.failedTests).toEqual(['test/a.test.mjs::exception']);
  });
  it('does not double count a failing suite or accept skipped-only defenders', async () => {
    const dir = project({ 'test/a.test.mjs': "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('suite',()=>{it('failure',()=>assert.equal(1,2));it.skip('skip',()=>{});});" });
    const result = await execute(dir);
    expect(result.run.tests).toEqual({ total: 1, passed: 0, failed: 1 }); expect(result.run.assertionFailures).toBe(1);
    writeFileSync(join(dir,'test/a.test.mjs'),body("test.skip('skip',()=>{});test.todo('todo');"));
    expect((await execute(dir)).run.outcome).toBe('error');
  });
  it('recognizes native test timeouts and hard command timeouts', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('hangs',{timeout:40},async(t)=>{const h=setInterval(()=>{},1000);t.signal.addEventListener('abort',()=>clearInterval(h),{once:true});try{await new Promise(()=>{});}finally{clearInterval(h);}});") });
    const result = await execute(dir);
    expect(result.timeouts).toBeGreaterThan(0); expect(result.run.assertionFailures).toBe(0);
    expect(result.run.outcome).toBe('fail');
    writeFileSync(join(dir,'test/a.test.mjs'),body("test('loop',()=>{while(true){}});"));
    const hard = await execute(dir,undefined,{budgetMs:400});
    expect(hard.run.outcome).toBe('timeout'); expect(hard.run.assertionFailures).toBe(0);
  });
  it('refuses a hook failure, incomplete process exit and a file with no tests', async () => {
    for (const source of ["import {before,test} from 'node:test';before(()=>{throw new Error('setup');});test('case',()=>{});", body("test('first',()=>{});test('unfinished',()=>process.exit(0));"), 'export const value=1;']) {
      const result = await execute(project({ 'test/a.test.mjs': source }));
      expect(result.run.outcome).toBe('error'); expect(result.run.assertionFailures).toBe(0);
    }
  });

  it('refuses non-default loading and never silently routes a Node project through auto', async () => {
    const original = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = '--import=unsupported';
    try { expect((await check()).ok).toBe(false); } finally { if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original; }
    const dir = project({ 'test/a.test.mjs': body("test('case',()=>{});") });
    const selected = await selectRunner({ projectDir: dir, name: 'auto', budgetMs: 2000 });
    expect(selected.runner?.name).not.toBe('node-test');
  });
  it('binds configuration edits to the native universe and rejects symlink escapes', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('case',()=>{});") });
    const before = await discover(dir); writeFileSync(join(dir,'package.json'),'{"type":"module","description":"changed"}');
    expect((await discover(dir)).testUniverseHash).not.toBe(before.testUniverseHash);
    const external=project({'external.mjs':body("test('outside',()=>{});")});
    symlinkSync(join(external,'external.mjs'),join(dir,'test','escape.mjs'));
    await expect(discover(dir)).rejects.toThrow(/outside/);
  });
  it('executes selected entries through a symlinked project root with canonical attribution', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('through alias',()=>assert.equal(1,1));") });
    const aliases = project({}); const alias = join(aliases, 'linked'); symlinkSync(dir, alias, 'dir');
    expect((await discover(alias)).files).toEqual(['test/a.test.mjs']);
    expect((await execute(alias)).run).toMatchObject({ outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 } });
  });
  it('bounds native collection output and command time', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('case',()=>{});") });
    await expect(discover(dir,{maxOutputBytes:1})).rejects.toThrow(/exceeded/);
    writeFileSync(join(dir,'test/a.test.mjs'),'while(true){}');
    await expect(discover(dir,{timeoutMs:300})).rejects.toThrow(/timeout/);
  });
  it('retains process isolation and serial worker policy', async () => {
    const dir = project({ 'test/a.test.mjs': body("test('isolated',()=>{globalThis.nativeSentinel=1;assert.equal(1,1);});"),
      'test/b.test.mjs':body("test('separate',()=>assert.equal(globalThis.nativeSentinel,undefined));") });
    expect((await execute(dir,['test/a.test.mjs','test/b.test.mjs'],{workers:2})).run.tests.passed).toBe(2);
    expect((await execute(dir,['test/a.test.mjs','test/b.test.mjs'],{workers:4,serial:true})).run.tests.passed).toBe(2);
    expect(existsSync(join(dir,'node_modules'))).toBe(false);
  });

  it('cleans its worker descendants on timeout and abnormal exit while preserving an unrelated sentinel', async () => {
    const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const source = body("import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';test('child',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('owned.json',JSON.stringify([process.pid,c.pid]));while(true){}});");
    const dir=project({'test/a.test.mjs':source});
    try {
      expect((await execute(dir,undefined,{budgetMs:800})).run.outcome).toBe('timeout');
      const pids=JSON.parse(readFileSync(join(dir,'owned.json'),'utf8'));
      for(const pid of pids)expect(alive(pid)).toBe(false);
      expect(alive(sentinel.pid)).toBe(true);
      writeFileSync(join(dir,'test/a.test.mjs'),source.replace('while(true){}','process.exit(0);'));
      expect((await execute(dir)).run.outcome).toBe('error');
      for(const pid of JSON.parse(readFileSync(join(dir,'owned.json'),'utf8')))expect(alive(pid)).toBe(false);
      expect(alive(sentinel.pid)).toBe(true);
    } finally {sentinel.kill('SIGKILL');}
  }, 10_000);
});
