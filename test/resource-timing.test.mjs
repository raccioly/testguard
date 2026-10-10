import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probe, sameWorkerPolicy } from '../src/probe/probe.mjs';
import { costReport } from '../src/probe/cost.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

it('counts real invocations once despite shared baselines and historical verdict reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-resource-timing-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/guard.mjs'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'test/guard.test.mjs'), "import {value} from '../src/guard.mjs';\n");
    writeFileSync(join(dir, 'runner.cjs'), `const fs=require('node:fs');const pass=fs.readFileSync('src/guard.mjs','utf8').includes('value = 1');fs.writeFileSync(process.argv.at(-1),JSON.stringify({success:pass,numTotalTests:1,numPassedTests:Number(pass),numFailedTests:Number(!pass),testResults:[{name:'test/guard.test.mjs',assertionResults:[{status:pass?'passed':'failed',fullName:'value equals one',failureMessages:pass?[]:['AssertionError: expected one']}]}]}));`);
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
    }
    const claims = { schemaVersion: 1, claims: [{ id: 'RESOURCE', statement: 'The value is one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', defendedBy: ['test/guard.test.mjs'], faults: [2,3].map((value) => ({ id: 'F'+value, description: 'Change the value.', faultClass: 'literal-changed', file: 'src/guard.mjs', find: 'value = 1', replace: 'value = '+value })) }] };
    const opts = { projectDir: dir, claims, runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, confirmRuns: 3, budgetMs: 3000 };
    const first = await probe(opts);
    expect(first.records.map((r) => r.verdict)).toEqual(['killed', 'killed']);
    expect(first.run.measurements.runnerInvocations).toBe(9); // 3 shared baseline + 3 for each fault.
    expect(first.run.measurements.runnerMs).toBeGreaterThan(0);
    expect(first.run.measurements.elapsedMs).toBeCloseTo(first.run.measurements.runnerMs + first.run.measurements.overheadMs, 5);
    expect(first.run).not.toHaveProperty('workers'); // Opaque commands have no enforceable native cap.
    expect(first.run).not.toHaveProperty('serial');
    const second = await probe({ ...opts, previous: first });
    expect(second.records.every((r) => r.reusedFrom === first.run.id)).toBe(true);
    expect(second.run.measurements.runnerInvocations).toBe(0);
    expect(second.run.measurements.runnerMs).toBe(0);
    expect(costReport(second.records, { run: second.run }).totalMs).toBeGreaterThan(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);

it('refuses evidence reuse across worker policies or an unknown older native policy', () => {
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 1 })).toBe(true);
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 2 })).toBe(false);
  expect(sameWorkerPolicy({ workers: 2 }, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({}, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({ serial: true }, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 2, serial: true })).toBe(true);
  expect(sameWorkerPolicy({}, { runnerCommand: 'opaque' })).toBe(true);
  expect(sameWorkerPolicy({ workers: 1 }, { runnerCommand: 'opaque' })).toBe(false);
});

it('remeasures native evidence when the worker ceiling changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-worker-reuse-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'test/value.test.mjs'), "import {it,expect} from 'vitest';import {value} from '../src/value.mjs';it('value',()=>expect(value).toBe(1));\n");
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
    const claims = { schemaVersion: 1, claims: [{ id: 'WORKERS', statement: 'Value stays one.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', defendedBy: ['test/value.test.mjs'], faults: [{ id: 'F1', description: 'Change value.', faultClass: 'literal-changed', file: 'src/value.mjs', find: 'value = 1', replace: 'value = 2' }] }] };
    const opts = { projectDir: dir, claims, runnerName: 'vitest', nodeModules: new URL('../node_modules', import.meta.url).pathname, confirmRuns: 1, budgetMs: 5000 };
    const first = await probe(opts);
    expect(first.records[0].verdict).toBe('killed');
    expect(first.run.measurements.runnerInvocations).toBe(2);
    const changed = await probe({ ...opts, previous: first, workers: 2 });
    expect(changed.records[0].verdict).toBe('killed');
    expect(changed.records[0]).not.toHaveProperty('reusedFrom');
    expect(changed.run.measurements.runnerInvocations).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
