#!/usr/bin/env node
// Narrow, reproducible comparison: the same classifier inputs and four existing
// fault recipes, through real probe() calls with fresh workers and N=3.
// Run under each Node executable with no other test process active:
// node .github/scripts/benchmark-node-runner.mjs --out /absolute/receipt-dir
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { probe } from '../../src/probe/probe.mjs';
import { writeSpecDoc } from '../../src/evidence/writer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, pairs: { type: 'string', default: '2' } } });
assert(values.out, '--out is required; timings and proof receipts are retained there');
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs >= 1 && pairs <= 10, '--pairs must be 1..10');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const classifier = readFileSync(join(ROOT, 'src/probe/classify.mjs'), 'utf8');
const inventory = JSON.parse(readFileSync(join(ROOT, 'testguard.claims.json'), 'utf8'));
const ids = ['TG-KILL-NEEDS-N', 'TG-TIMEOUT-NEVER-KILLS', 'TG-COMPILE-ERROR-NAMED', 'TG-SURVIVOR-PROVES-THE-SUBJECT-RUNS'];
const claims = { ...inventory, claims: ids.map((id) => {
  const claim = structuredClone(inventory.claims.find((c) => c.id === id));
  assert(claim && claim.faults.length === 1, `expected one unchanged recipe for ${id}`);
  claim.defendedBy = ['test/classify.test.mjs'];
  return claim;
}) };
const pass = { outcome: 'pass', assertionFailures: 0, timeouts: 0 };
const kill = { outcome: 'fail', assertionFailures: 1, timeouts: 0 };
const timeout = { outcome: 'fail', assertionFailures: 0, timeouts: 1 };
const error = { outcome: 'error', assertionFailures: 0, timeouts: 0 };
const healthy = { defenders: ['test/classify.test.mjs'], anchor: { status: 'ok' }, baselineRuns: [pass, pass, pass], probeRuns: [pass, pass, pass], confirmRuns: 3 };
const rows = [
  ['nocover precedes missing anchor', { defenders: [], anchor: { status: 'anchor-missing' } }, { verdict: 'nocover' }],
  ['missing anchor', { anchor: { status: 'anchor-missing' } }, { verdict: 'unverifiable', reason: 'anchor-missing' }],
  ['ambiguous anchor', { anchor: { status: 'anchor-ambiguous' } }, { verdict: 'unverifiable', reason: 'anchor-ambiguous' }],
  ['failed defender load', { anchor: { status: 'defenders-failed-to-load' }, baselineRuns: [error] }, { verdict: 'unverifiable', reason: 'defenders-failed-to-load' }],
  ['red baseline', { baselineRuns: [pass, kill] }, { verdict: 'flaky-defender', reason: 'defenders-not-green' }],
  ['empty baseline', { baselineRuns: [] }, { verdict: 'flaky-defender', reason: 'defenders-not-green' }],
  ['load failure', { probeRuns: [error] }, { verdict: 'fault-invalid', reason: 'suite-failed-to-load' }],
  ['syntax error', { probeRuns: [{ ...error, loadMessage: 'Failed to parse source: invalid JS syntax' }] }, { verdict: 'fault-invalid', reason: 'replacement-does-not-compile' }],
  ['esbuild syntax error', { probeRuns: [{ ...error, loadMessage: 'Transform failed with 1 error: Expected ")" but found ";"' }] }, { verdict: 'fault-invalid', reason: 'replacement-does-not-compile' }],
  ['test timeout', { probeRuns: [timeout] }, { verdict: 'timeout', reason: 'test-timed-out' }],
  ['budget timeout', { probeRuns: [{ ...timeout, outcome: 'timeout' }] }, { verdict: 'timeout', reason: 'test-timed-out' }],
  ['confirmed kill', { probeRuns: [kill, kill, kill] }, { verdict: 'killed' }],
  ['confirmed survivor', {}, { verdict: 'survived' }],
  ['mixed confirmations', { probeRuns: [kill, pass, kill] }, { verdict: 'flaky-defender', reason: 'inconsistent-probe' }],
  ['failure without assertions', { probeRuns: [{ outcome: 'fail', assertionFailures: 0, timeouts: 0 }, pass, pass] }, { verdict: 'flaky-defender', reason: 'inconsistent-probe' }],
  ['unreached survivor', { subjectReached: false }, { verdict: 'unverifiable', reason: 'subject-not-executed' }],
  ['reached survivor', { subjectReached: true }, { verdict: 'survived' }],
];
const corpus = rows.map(([name, changes, expected]) => [name, { ...healthy, ...changes }, expected]);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const toolSources = Object.fromEntries(['node-test.mjs', 'node/runner.mjs', 'node/entry.mjs', 'node/report.mjs', 'shared.mjs', 'discovery.mjs', 'lifecycle.mjs', 'vitest.mjs'].map((file) => [file, sha256(readFileSync(join(ROOT, 'src/probe/runners', file)))]));
const vitestVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/vitest/package.json'), 'utf8')).version;
const proofProjection = (evidence) => evidence.records.map((r) => ({
  id: `${r.claim.id}/${r.subject.id}`, verdict: r.verdict, reason: r.detail.reason ?? null,
  baseline: r.detail.baselineRuns.map(({ durationMs, ...run }) => run),
  probe: r.detail.probeRuns.map(({ durationMs, ...run }) => run),
}));
const results = [];
async function measure(engine, label) {
  const dir = mkdtempSync(join(tmpdir(), 'testguard-benchmark-'));
  const receipts = join(out, `${label}-${engine}-workers.jsonl`);
  const outcomes = join(out, `${label}-${engine}-outcomes.jsonl`);
  writeFileSync(receipts, '', { mode: 0o600 });
  writeFileSync(outcomes, '', { mode: 0o600 });
  try {
    mkdirSync(join(dir, 'src/probe'), { recursive: true }); mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/probe/classify.mjs'), classifier);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', ...(engine === 'vitest' ? { devDependencies: { vitest: vitestVersion } } : {}) }));
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
    const imports = engine === 'vitest' ? "import {it,expect} from 'vitest';" : "import {test as it} from 'node:test'; import assert from 'node:assert/strict';";
    const assertion = engine === 'vitest' ? 'expect(classify(input)).toEqual(expected)' : 'assert.deepStrictEqual(classify(input),expected)';
    writeFileSync(join(dir, 'test/classify.test.mjs'), `${imports}
import {appendFileSync,readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {classify} from '../src/probe/classify.mjs';
const sourceHash=createHash('sha256').update(readFileSync(new URL('../src/probe/classify.mjs',import.meta.url))).digest('hex');
appendFileSync(${JSON.stringify(receipts)},JSON.stringify({pid:process.pid,execPath:process.execPath,version:process.versions.node,collect:process.env.TESTGUARD_NODE_COLLECT==='1'})+'\\n');
const record=(name,passed)=>appendFileSync(${JSON.stringify(outcomes)},JSON.stringify({pid:process.pid,sourceHash,name,passed})+'\\n');
for(const [name,input,expected] of ${JSON.stringify(corpus)}) it(name,()=>{try{${assertion};record(name,true);}catch(error){record(name,false);throw error;}});\n`);
    if (engine === 'vitest') symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.testguard/\n');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'benchmark']]) execFileSync('git', args, { cwd: dir, timeout: 5000 });
    const start = performance.now();
    const evidence = await probe({ projectDir: dir, claims, runnerName: engine, confirmRuns: 3, budgetMs: 30_000, workers: 1, serial: true, escalate: false, toolVersion: 'benchmark' });
    const wallMs = performance.now() - start;
    writeSpecDoc('evidence', join(out, `${label}-${engine}-evidence.json`), evidence);
    assert.equal(evidence.records.length, 4);
    for (const r of evidence.records) {
      assert.equal(r.verdict, 'killed', `${r.claim.id} must be caught by both frameworks`);
      assert.equal(r.detail.baselineRuns.length, 3); assert.equal(r.detail.probeRuns.length, 3);
      for (const run of r.detail.baselineRuns) { assert.equal(run.outcome, 'pass'); assert.equal(run.tests.total, corpus.length); }
      for (const run of r.detail.probeRuns) { assert.equal(run.outcome, 'fail'); assert(run.assertionFailures > 0); assert.equal(run.tests.total, corpus.length); }
    }
    const workers = readFileSync(receipts, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.collect);
    assert.equal(workers.length, 15, 'three shared baseline runs plus four faults times three confirmations');
    assert.equal(new Set(workers.map((r) => r.pid)).size, 15, 'each confirmation must have a fresh worker');
    for (const r of workers) { assert.equal(r.version, process.versions.node); assert.equal(r.execPath, process.execPath); }
    const testResults = readFileSync(outcomes, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(testResults.length, 15 * corpus.length, 'every test must execute in every measured worker');
    const bySource = new Map();
    for (const worker of workers) {
      const tests = testResults.filter((r) => r.pid === worker.pid);
      assert.equal(tests.length, corpus.length); assert.equal(new Set(tests.map((r) => r.name)).size, corpus.length);
      assert.equal(new Set(tests.map((r) => r.sourceHash)).size, 1);
      const { sourceHash } = tests[0]; const projection = tests.map(({ name, passed }) => ({ name, passed }));
      const prior = bySource.get(sourceHash);
      if (prior) { assert.deepStrictEqual(prior.tests, projection, 'confirmations must agree per test'); prior.confirmations++; }
      else bySource.set(sourceHash, { sourceHash, confirmations: 1, tests: projection });
    }
    assert.equal(bySource.size, 5, 'healthy source and four distinct mutations');
    for (const group of bySource.values()) assert.equal(group.confirmations, 3);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', 'probe must restore the measured tree');
    const runnerMs = evidence.records.flatMap((r, i) => [...(i === 0 ? r.detail.baselineRuns : []), ...r.detail.probeRuns]).reduce((sum, r) => sum + r.durationMs, 0);
    const result = { label, engine, wallMs, runnerMs, workerCount: workers.length, projection: proofProjection(evidence), testProjection: [...bySource.values()].sort((a,b) => a.sourceHash.localeCompare(b.sourceHash)) };
    console.log(JSON.stringify({ label, engine, wallMs: Math.round(wallMs), runnerMs }));
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// One unmeasured warm-up per engine, then reversed-order pairs. No parallel
// execution, evidence reuse or reduction in confirmations contributes to speed.
await measure('vitest', 'warmup'); await measure('node-test', 'warmup');
for (let i = 0; i < pairs; i++) {
  const pair = [];
  for (const engine of i % 2 ? ['node-test', 'vitest'] : ['vitest', 'node-test']) pair.push(await measure(engine, `pair-${i + 1}`));
  assert.deepStrictEqual(pair[0].projection, pair[1].projection, 'every verdict and run count must agree');
  assert.deepStrictEqual(pair[0].testProjection, pair[1].testProjection, 'every baseline, failed test identity and passed test must agree');
  results.push(...pair);
}
const median = (numbers) => { const sorted = [...numbers].sort((a,b) => a-b); const middle = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2; };
const medians = Object.fromEntries(['vitest', 'node-test'].map((engine) => [engine, median(results.filter((r) => r.engine === engine).map((r) => r.wallMs))]));
const receipt = { scope: 'One classifier file, 17 identical inputs, four unchanged fault recipes, N=3; no generic framework compatibility claim.', generatedAt: new Date().toISOString(), runtime: { version: process.versions.node, execPath: process.execPath, platform: platform(), arch: arch(), vitestVersion }, classifierHash: sha256(classifier), corpusHash: sha256(JSON.stringify(corpus)), claimsHash: sha256(JSON.stringify(claims)), toolSources, pairs, medians, speedup: medians.vitest/medians['node-test'], results };
writeFileSync(join(out, 'summary.json'), JSON.stringify(receipt, null, 2)+'\n');
console.log(JSON.stringify({ medians, speedup: receipt.speedup }));
