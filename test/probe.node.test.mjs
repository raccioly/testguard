// @req FR-10
// @req FR-16
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { run, discoverTests } from '../src/probe/runners/node-test.mjs';
import { selectRunner } from '../src/probe/runners/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures/known-answer-node');
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));
describe('native Node known-answer proof', () => {
  let dir, claims, evidence;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-node-fixture-'));
    cpSync(FIXTURE, dir, { recursive: true });
    for (const args of [['init','-q'],['add','.'],['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) execFileSync('git',args,{cwd:dir,timeout:5000});
    claims = loadClaims(join(dir,'testguard.claims.json'));
    evidence = await probe({ projectDir:dir, claims, runnerName:'node-test', confirmRuns:3, budgetMs:5000, mode:'worktree', toolVersion:'test' });
  }, 30_000);
  afterAll(() => { if(dir)rmSync(dir,{recursive:true,force:true}); });
  it('reproduces every independently verified verdict and reason', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict:r.verdict, reason:r.detail.reason }]));
    for (const [id, oracle] of Object.entries(expected.expected)) {
      expect(actual[id]?.verdict,id).toBe(oracle.verdict);
      if(oracle.reason)expect(actual[id]?.reason,id).toBe(oracle.reason);
    }
    expect(Object.keys(actual)).toHaveLength(Object.keys(expected.expected).length);
  });
  it('emits conforming builtin-runtime evidence with N/N green baselines and assertion-only kills', () => {
    expect(validate('evidence',evidence).errors).toEqual([]);
    expect(evidence.run.runner).toEqual({name:'node-test',version:process.versions.node,source:'builtin'});
    for (const r of evidence.records.filter((r)=>r.verdict==='killed'||r.verdict==='survived')) {
      expect(r.detail.baselineRuns).toHaveLength(3);expect(r.detail.probeRuns).toHaveLength(3);
      expect(r.detail.baselineRuns.every((b)=>b.outcome==='pass')).toBe(true);
      if(r.verdict==='killed')expect(r.detail.probeRuns.every((p)=>p.outcome==='fail'&&p.assertionFailures>0)).toBe(true);
    }
  });
  it('restores every target and removes its scratch worktree after failures/timeouts', () => {
    expect(execFileSync('git',['status','--porcelain'],{cwd:dir,encoding:'utf8'})).toBe('');
    expect(execFileSync('git',['worktree','list','--porcelain'],{cwd:dir,encoding:'utf8'}).match(/^worktree /gm)).toHaveLength(1);
    expect(readFileSync(join(dir,'src/policy.mjs'),'utf8')).toBe(readFileSync(join(FIXTURE,'src/policy.mjs'),'utf8'));
  });
  it('reuses matching Node evidence and remeasures across framework identity or worker policy', async () => {
    const subset = {...claims,claims:claims.claims.filter((c)=>c.id==='NODE-ALLOW')};
    const options = {projectDir:dir,claims:subset,runnerName:'node-test',confirmRuns:3,budgetMs:5000,toolVersion:'test',previous:evidence};
    const reused = await probe(options);
    expect(reused.records[0].reusedFrom).toBe(evidence.run.id);
    const changed = await probe({...options,workers:2,serial:false});
    expect(changed.records[0].reusedFrom).toBeUndefined();
    expect(changed.records[0].verdict).toBe('killed');
    const foreign = structuredClone(evidence);foreign.run.runner={name:'vitest',version:'5.0.2'};
    foreign.records.forEach((r)=>{r.inputs.testUniverseHash='0'.repeat(64);});
    const remeasured = await probe({...options,previous:foreign});
    expect(remeasured.records[0].reusedFrom).toBeUndefined();
    expect(remeasured.records[0].verdict).toBe('killed');
  }, 15_000);
  it('cancels the real CLI during a live fault, restoring targets without publishing partial evidence', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tg-node-cancel-'));
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let child;
    try {
      cpSync(FIXTURE, scratch, { recursive: true });
      const source = readFileSync(join(scratch, 'src/policy.mjs'), 'utf8');
      writeFileSync(join(scratch, 'test/policy.test.mjs'), `import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; import { ready } from '../src/policy.mjs';
test('live fault',async()=>{if(!await ready()){writeFileSync('live.json',JSON.stringify({pid:process.pid}));while(true){}}});`);
      const subset = { ...claims, claims: claims.claims.filter((c) => c.id === 'NODE-READY') };
      subset.claims[0].faults[0].replace = 'export async function ready() {\n  return false;';
      writeFileSync(join(scratch, 'testguard.claims.json'), JSON.stringify(subset));
      for (const args of [['init','-q'],['add','.'],['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) execFileSync('git',args,{cwd:scratch,timeout:5000});
      child = spawn(process.execPath, [join(ROOT, 'cli/testguard.mjs'), 'probe', scratch, '--runner', 'node-test', '--in-place', '--budget', '30000', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostic = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { diagnostic = (diagnostic + bytes).slice(-4000); });
      const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(scratch, 'live.json')) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(join(scratch, 'live.json')), diagnostic).toBe(true);
      const worker = JSON.parse(readFileSync(join(scratch, 'live.json'), 'utf8')).pid;
      child.kill('SIGINT');
      expect(await closed).toEqual({ code: 130, signal: null });
      expect(readFileSync(join(scratch, 'src/policy.mjs'), 'utf8')).toBe(source);
      expect(existsSync(join(scratch, '.testguard/evidence.json'))).toBe(false);
      expect(() => process.kill(worker, 0)).toThrow();
      expect(() => process.kill(sentinel.pid, 0)).not.toThrow();
    } finally {
      child?.kill('SIGKILL'); sentinel.kill('SIGKILL');
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});

// Runtime acceptance remains independent of the focused self-probe defenders.
describe('native Node collection and runtime acceptance', () => {
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
