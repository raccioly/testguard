import { it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FIXTURE_GIT } from './helpers/git.mjs';

// A broken --runner-cmd makes every defender fail to load. Fixing the command
// in place changes nothing the record's inputs hash — target, defenders and
// test files are byte-identical — so the stale `defenders-failed-to-load`
// verdict used to be reused, and printed as current, until --no-reuse.
const REPORTER = "const fs=require('node:fs');const pass=fs.readFileSync('src/guard.mjs','utf8').includes('value = 1');fs.writeFileSync(process.argv.at(-1),JSON.stringify({success:pass,numTotalTests:1,numPassedTests:Number(pass),numFailedTests:Number(!pass),testResults:[{name:'test/guard.test.mjs',assertionResults:[{status:pass?'passed':'failed',fullName:'value equals one',failureMessages:pass?[]:['AssertionError: expected one']}]}]}));";
const by = { producer: 'human', by: 'fixture' };
const CLAIMS = { schemaVersion: 1, claims: [{ id: 'VALUE-001', statement: 'The value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['test/guard.test.mjs'], faults: [{ id: 'F1', description: 'Change the value.', faultClass: 'literal-changed', file: 'src/guard.mjs', find: 'value = 1', replace: 'value = 2', producedBy: by }] }] };

let dir;
const node = JSON.stringify(process.execPath);
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };
const run = async (cmd, extra = []) => {
  const { main } = await import('../src/cli.mjs');
  const { lines, io } = capture();
  const code = await main(['probe', dir, '--confirm', '1', '--progress', 'none', '--verbose', '--runner-cmd', cmd, ...extra], io);
  return { code, out: lines.out, err: lines.err.join('\n') };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-runner-identity-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/guard.mjs'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'test/guard.test.mjs'), "import {value} from '../src/guard.mjs';\n");
  writeFileSync(join(dir, 'runner.cjs'), REPORTER);
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(CLAIMS, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('a fixed --runner-cmd is measured again, never answered with the broken command\'s verdict', async () => {
  const broken = await run(`${node} runnr.cjs {files} {out}`);
  expect(broken.code).toBe(1);
  expect(broken.out.join('\n')).toMatch(/UNVERIFIABLE\?\s+VALUE-001\/F1.*defenders-failed-to-load/);

  const fixed = await run(`${node} runner.cjs {files} {out}`);
  const text = fixed.out.join('\n');
  expect(text).not.toMatch(/\(reused\)/);
  expect(text).toMatch(/killed\?\s+VALUE-001\/F1/);
  expect(fixed.code).toBe(0);

  // The same command again is the same measurement: reuse still works.
  const again = await run(`${node} runner.cjs {files} {out}`);
  expect(again.out.join('\n')).toMatch(/killed\?\s+VALUE-001\/F1.*\(reused\)/);
}, 30_000);

it('the baseline sentence is its own line, not glued to the origins line', async () => {
  const { out } = await run(`${node} runner.cjs {files} {out}`, ['--no-reuse', '--cost']);
  const origins = out.find((l) => l.includes('declared origins, not authenticated independence'));
  expect(origins).toBeDefined();
  expect(origins).not.toMatch(/No baseline/);
  expect(out).toContain('No baseline.');
  // Every duration in the cost block is a whole number of ms or a rounded second.
  const cost = out.join('\n');
  expect(cost).toMatch(/actual elapsed \d+(?:ms|\.\ds|s);/);
  expect(cost).not.toMatch(/\d\.\d{2,}ms/);
}, 30_000);

it('a verdict measured under one runner is not reused under another', async () => {
  const { probe } = await import('../src/probe/probe.mjs');
  const { loadClaims } = await import('../src/claims/load.mjs');
  const opts = { projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), runnerCommand: `${node} runner.cjs {files} {out}`, confirmRuns: 1, budgetMs: 5000, escalate: false };
  const first = await probe({ ...opts, runnerName: 'vitest' });
  expect(first.run.runner.name).toBe('vitest');
  const same = await probe({ ...opts, runnerName: 'vitest', previous: first });
  expect(same.records[0].reusedFrom).toBe(first.run.id);
  const other = await probe({ ...opts, runnerName: 'jest', previous: first });
  expect(other.run.runner.name).toBe('jest');
  expect(other.records[0]).not.toHaveProperty('reusedFrom');
}, 30_000);

it('any change to the command re-measures, not only one that fixes a load failure', async () => {
  // A load failure is never reused anyway; a kill or a survivor would be. A
  // different command is a different measurement even when both work.
  const { probe } = await import('../src/probe/probe.mjs');
  const { loadClaims } = await import('../src/claims/load.mjs');
  const opts = { projectDir: dir, claims: loadClaims(join(dir, 'testguard.claims.json')), confirmRuns: 1, budgetMs: 5000, escalate: false };
  const first = await probe({ ...opts, runnerCommand: `${node} runner.cjs {files} {out}` });
  expect(first.records[0].verdict).toBe('killed');
  const same = await probe({ ...opts, runnerCommand: `${node}  runner.cjs  {files} {out}`, previous: first });
  expect(same.records[0].reusedFrom).toBe(first.run.id);
  const changed = await probe({ ...opts, runnerCommand: `${node} runner.cjs --config other {files} {out}`, previous: first });
  expect(changed.records[0].verdict).toBe('killed');
  expect(changed.records[0]).not.toHaveProperty('reusedFrom');
  expect(changed.records[0].inputs.testUniverseHash).not.toBe(first.records[0].inputs.testUniverseHash);
}, 30_000);
