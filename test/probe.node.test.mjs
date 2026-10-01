// @req FR-10
// @req FR-16
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';

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
