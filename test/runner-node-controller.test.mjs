// @req FR-10
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { run, discoverTests } from '../src/probe/runners/node-test.mjs';

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
const discover = (dir) => discoverTests({ projectDir: dir, version: process.versions.node });

describe('native controller execution boundaries', () => {
  it('collects native custom names and empty files, without executing bodies or listing imported declarations as entries', async () => {
    const dir = project({
      'test/custom-name.mjs': body("import '../helpers/case.mjs'; test('must not run', () => { throw new Error('BODY_EXECUTED'); });"),
      'test/empty.mjs': 'export const x=1;',
      'helpers/case.mjs': body("test('imported', () => { throw new Error('HELPER_EXECUTED'); });"),
      'elsewhere/a.spec.mjs': body("test('not a native test entry', () => {});"),
    });
    expect((await discover(dir)).files).toEqual(['test/custom-name.mjs', 'test/empty.mjs']);
  });
  it('gives each execution fresh workers and handles an inherited parent test context', async () => {
    const dir = project({ 'test/a.test.mjs': body("import {writeFileSync} from 'node:fs';test('pid',()=>{writeFileSync('pid.txt',String(process.pid));assert.equal(1,1);});") });
    const original = process.env.NODE_TEST_CONTEXT; process.env.NODE_TEST_CONTEXT = 'child-v8';
    try {
      expect((await execute(dir)).run.outcome).toBe('pass'); const first = readFileSync(join(dir,'pid.txt'),'utf8');
      expect((await execute(dir)).run.outcome).toBe('pass'); expect(readFileSync(join(dir,'pid.txt'),'utf8')).not.toBe(first);
    } finally { if(original===undefined)delete process.env.NODE_TEST_CONTEXT;else process.env.NODE_TEST_CONTEXT=original; }
  });
  it('enforces the worker ceiling through actual concurrent test-file execution', async () => {
    const source = body("import {appendFileSync} from 'node:fs';test('worker',async()=>{appendFileSync('active.jsonl',JSON.stringify({pid:process.pid,start:true})+'\\n');await new Promise(r=>setTimeout(r,100));appendFileSync('active.jsonl',JSON.stringify({pid:process.pid,start:false})+'\\n');});");
    const dir=project({'test/a.test.mjs':source,'test/b.test.mjs':source,'test/c.test.mjs':source});
    for(const options of [{workers:2},{workers:4,serial:true}]) {
      writeFileSync(join(dir,'active.jsonl'),'');
      expect((await execute(dir,['test/a.test.mjs','test/b.test.mjs','test/c.test.mjs'],options)).run.outcome).toBe('pass');
      const active=new Set();let maximum=0;
      for(const line of readFileSync(join(dir,'active.jsonl'),'utf8').trim().split('\n')) {const e=JSON.parse(line);if(e.start)active.add(e.pid);else active.delete(e.pid);maximum=Math.max(maximum,active.size);}
      expect(maximum).toBeGreaterThan(0);expect(maximum).toBeLessThanOrEqual(options.serial?1:2);expect(active.size).toBe(0);
    }
  });
});
