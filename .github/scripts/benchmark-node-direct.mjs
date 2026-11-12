#!/usr/bin/env node
// Same fixture commit and recipes, N=3, fresh workers, no reused verdicts.
// Warmups excluded; ABBA timing is informational, mismatched proof fails.
// The fixture is also probed with --fault-workers (#237): its records must be
// the serial ones, record for record, apart from timings.
// Then a speed check that survives a noisy runner: base and head probe the
// same CPU-bound project on this runner, in interleaved rounds whose order
// rotates, and the MEDIANS are compared as ratios, never absolute seconds:
// head serial must not be slower than base by more than --max-serial-ratio,
// and head with --fault-workers must beat base serial by --max-fanout-ratio.
// Run without competing test processes. Keep the receipt directory for audit.
// node .github/scripts/benchmark-node-direct.mjs --before-ref <SHA> --out <dir>
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { probe as after } from '../../src/probe/probe.mjs';
import { readSpecDoc, writeSpecDoc } from '../../src/evidence/writer.mjs';
import { detectContention } from '../../src/probe/contention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: {
  out: { type: 'string' }, 'before-ref': { type: 'string' },
  rounds: { type: 'string', default: '5' }, 'fault-workers': { type: 'string', default: '3' },
  'max-serial-ratio': { type: 'string', default: '1.25' }, 'max-fanout-ratio': { type: 'string', default: '0.85' },
} });
assert(values.out && /^[0-9a-f]{40}$/.test(values['before-ref'] ?? ''), '--out and an exact --before-ref commit SHA are required');
const rounds = Number(values.rounds);
const fanOut = Number(values['fault-workers']);
const maxSerialRatio = Number(values['max-serial-ratio']);
const maxFanOutRatio = Number(values['max-fanout-ratio']);
assert(Number.isSafeInteger(rounds) && rounds >= 3 && rounds % 2 === 1, '--rounds must be an odd integer of at least 3, so the median is a sample');
assert(Number.isSafeInteger(fanOut) && fanOut >= 2, '--fault-workers must be at least 2');
assert(maxSerialRatio > 0 && maxFanOutRatio > 0, 'ratios must be positive');
const out = resolve(values.out);
mkdirSync(out, { recursive: true, mode: 0o700 });
mkdirSync(join(out, 'workers'), { mode: 0o700 }); // Refuse to overwrite a previous study.
const tool = mkdtempSync(join(tmpdir(), 'tg-direct-reference-'));
const dir = mkdtempSync(join(tmpdir(), 'tg-direct-bench-'));
const speedDir = mkdtempSync(join(tmpdir(), 'tg-direct-speed-'));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000 }).trim();
// The base commit predates `exceptionFailures`; a kill there was counted wholly in `assertionFailures`. Compare the sum.
// `alone` marks which runs a fan-out measured with nothing else in flight (#270): a
// property of the schedule, not of the verdict, so it is not compared.
const comparable = ({ durationMs, exceptionFailures, kindNotReported, alone, ...run }) => ({ ...run, assertionFailures: run.assertionFailures + (exceptionFailures ?? 0) });
const projection = (record) => ({
  id: record.claim.id + '/' + record.subject.id,
  subject: record.subject,
  verdict: record.verdict,
  reason: record.detail.reason ?? null,
  defenders: record.defenders,
  targetHash: record.inputs?.targetHash,
  defenderHashes: record.inputs?.defenderHashes,
  discoveryHashes: record.inputs?.discoveryHashes,
  baseline: (record.detail.baselineRuns ?? []).map(comparable),
  probe: (record.detail.probeRuns ?? []).map(comparable),
  negativeControl: record.detail.negativeControl ?? null,
});
// testUniverseHash intentionally changes: it binds the changed adapter itself.
// The unchanged entries, source bytes, defender bytes and outcomes are checked.
try {
  const archive = execFileSync('git', ['archive', '--format=tar', values['before-ref']], { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
  execFileSync('tar', ['-xf', '-', '-C', tool], { input: archive, timeout: 10000 });
  symlinkSync(join(root, 'node_modules'), join(tool, 'node_modules'), 'junction');
  const { probe: before } = await import(pathToFileURL(join(tool, 'src/probe/probe.mjs')).href);
  cpSync(join(root, 'fixtures/known-answer-node'), dir, { recursive: true });
  for (const file of readdirSync(join(dir, 'test'))) {
    const path = join(dir, 'test', file);
    const receipt = `import {writeFileSync as receipt} from 'node:fs';if(process.env.TESTGUARD_NODE_COLLECT!=='1')receipt(${JSON.stringify(join(out, 'workers'))}+'/'+process.pid+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid,version:process.versions.node,file:${JSON.stringify(file)}}),{flag:'wx'});\n`;
    writeFileSync(path, receipt + readFileSync(path, 'utf8'));
  }
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=research', '-c', 'user.email=research@example.invalid', 'commit', '-qm', 'same inputs']]) git(...args);
  const head = git('rev-parse', 'HEAD');
  const claims = readSpecDoc('claims', join(dir, 'testguard.claims.json'));
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'))).expected;
  const results = [];
  let reference;
  async function wave(strategy, label, measured) {
    assert(!detectContention().detected, 'foreign runner contention');
    const ids = new Set(readdirSync(join(out, 'workers')));
    const start = performance.now();
    const faultWorkers = strategy === 'fanout' ? fanOut : 1;
    const evidence = await ({ before, after, fanout: after }[strategy])({ projectDir: dir, claims, runnerName: 'node-test', confirmRuns: 3, workers: 1, serial: true, budgetMs: 10000, escalate: false, ...(strategy === 'fanout' ? { faultWorkers } : {}) });
    if (strategy === 'fanout') {
      assert.equal(evidence.run.faultWorkers, fanOut);
      // Only a contended timeout or inconsistent probe may be re-measured.
      for (const record of evidence.records.filter((r) => r.detail.remeasuredSerially)) {
        assert(record.verdict === 'timeout' || record.detail.reason === 'inconsistent-probe' || expected[record.claim.id + '/' + record.subject.id].verdict === 'timeout' || expected[record.claim.id + '/' + record.subject.id].reason === 'inconsistent-probe', 'unexpected serial re-measure of ' + record.claim.id);
      }
    }
    const elapsedMs = performance.now() - start;
    assert.equal(evidence.run.repo.head, head);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
    assert.equal(evidence.records.length, Object.keys(expected).length);
    assert.deepStrictEqual(evidence.records.map((record) => record.claim.id + '/' + record.subject.id), claims.claims.flatMap((claim) => claim.faults.map((fault) => claim.id + '/' + fault.id)));
    for (const record of evidence.records) {
      const oracle = expected[record.claim.id + '/' + record.subject.id];
      assert.equal(record.verdict, oracle.verdict);
      if (oracle.reason) assert.equal(record.detail.reason, oracle.reason);
      assert(!record.reusedFrom);
      if (record.verdict === 'killed') {
        assert.equal(record.detail.probeRuns.length, 3);
        assert.equal(record.detail.baselineRuns.length, 3);
        assert(record.detail.baselineRuns.every((run) => run.outcome === 'pass'));
        assert(record.detail.probeRuns.every((run) => run.outcome === 'fail' && run.assertionFailures + (run.exceptionFailures ?? 0) > 0));
      }
    }
    const projected = evidence.records.map(projection);
    reference ??= projected;
    assert.deepStrictEqual(projected, reference);
    writeSpecDoc('evidence', join(out, label + '-' + strategy + '.json'), evidence);
    const receipts = readdirSync(join(out, 'workers')).filter((file) => !ids.has(file)).map((file) => JSON.parse(readFileSync(join(out, 'workers', file))));
    for (const receipt of receipts) assert.equal(receipt.version, process.versions.node);
    if (measured) results.push({ strategy, label, elapsedMs, measurements: evidence.run.measurements, workerReceipts: receipts.length, parentPids: new Set(receipts.map((receipt) => receipt.ppid)).size });
  }
  await wave('before', 'warm', false);
  await wave('after', 'warm', false);
  for (const [i, strategy] of ['before', 'after', 'after', 'before'].entries()) await wave(strategy, String(i), true);
  // The fan-out must reproduce the serial evidence on the known-answer fixture.
  await wave('fanout', 'proof', false);
  const mean = (strategy) => results.filter((result) => result.strategy === strategy).reduce((sum, result) => sum + result.elapsedMs, 0) / 2;

  const speed = await speedStudy(before);
  const summary = {
    version: process.versions.node,
    toolHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    beforeRef: values['before-ref'], head,
    beforeMs: mean('before'), afterMs: mean('after'), speedup: mean('before') / mean('after'),
    verifiedOutcomes: 40, results, speed,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  const verdict = `serial ratio ${speed.serialRatio.toFixed(3)} (max ${maxSerialRatio}), fan-out ratio ${speed.fanOutRatio.toFixed(3)} at --fault-workers ${fanOut} (max ${maxFanOutRatio}), medians of ${rounds} interleaved rounds on ${speed.cpus} CPUs`;
  console.log(verdict);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Probe speed, base vs head\n\n${verdict}\n`, { flag: 'a' });
  assert(speed.serialRatio <= maxSerialRatio, `head probes serially ${speed.serialRatio.toFixed(3)}x as long as base (max ${maxSerialRatio})`);
  assert(speed.fanOutRatio <= maxFanOutRatio, `--fault-workers ${fanOut} takes ${speed.fanOutRatio.toFixed(3)}x as long as base serial (max ${maxFanOutRatio})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tool, { recursive: true, force: true });
  rmSync(speedDir, { recursive: true, force: true });
}

/**
 * Six claims, one fault each, every defender its own CPU-bound node:test file:
 * a probe whose cost is the runner, as it is in a real repository. Base and
 * head run it in interleaved rounds (the order rotates each round, so drift in
 * the runner's speed lands on every strategy alike) and only medians are
 * compared, as ratios.
 */
async function speedStudy(before) {
  const sh = (...args) => execFileSync('git', args, { cwd: speedDir, encoding: 'utf8', timeout: 10000 }).trim();
  mkdirSync(join(speedDir, 'src'));
  mkdirSync(join(speedDir, 'test'));
  writeFileSync(join(speedDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (const id of ids) {
    writeFileSync(join(speedDir, 'src', `${id}.mjs`), `export const value = () => ${id.charCodeAt(0)};\n`);
    writeFileSync(join(speedDir, 'test', `${id}.test.mjs`), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/${id}.mjs';\ntest('${id}', () => {\n  let x = 0;\n  for (let i = 0; i < 6e7; i++) x = (x + i) % 9973;\n  assert.equal(value() + (x >= 0 ? 0 : 1), ${id.charCodeAt(0)});\n});\n`);
  }
  const by = { producer: 'human' };
  const speedClaims = { schemaVersion: 1, claims: ids.map((id) => ({
    id: `SPEED-${id}`, statement: `${id} holds.`, source: { kind: 'manual', ref: 'benchmark' }, severity: 'high', producedBy: by,
    defendedBy: [`test/${id}.test.mjs`],
    faults: [{ id: 'F1', description: 'value altered', faultClass: 'return-altered', file: `src/${id}.mjs`, find: `=> ${id.charCodeAt(0)}`, replace: '=> 0', producedBy: by }],
  })) };
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=research', '-c', 'user.email=research@example.invalid', 'commit', '-qm', 'speed']]) sh(...args);
  const strategies = { before: [before, 1], after: [after, 1], fanout: [after, fanOut] };
  const samples = { before: [], after: [], fanout: [] };
  const run = async (name) => {
    assert(!detectContention().detected, 'foreign runner contention');
    const [probe, faultWorkers] = strategies[name];
    const start = performance.now();
    const evidence = await probe({ projectDir: speedDir, claims: speedClaims, runnerName: 'node-test', confirmRuns: 3, workers: 1, serial: true, budgetMs: 60000, escalate: false, ...(faultWorkers > 1 ? { faultWorkers } : {}) });
    const ms = performance.now() - start;
    assert.deepStrictEqual(evidence.records.map((r) => r.verdict), ids.map(() => 'killed'), `${name}: every speed fault must be killed`);
    assert.equal(sh('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1, `${name}: a scratch worktree was left behind`);
    return ms;
  };
  await run('before'); // warm-up, excluded
  const order = ['before', 'after', 'fanout'];
  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < order.length; k++) {
      const name = order[(round + k) % order.length];
      samples[name].push(await run(name));
    }
  }
  const medians = Object.fromEntries(Object.entries(samples).map(([name, xs]) => [name, median(xs)]));
  return { cpus: availableParallelism(), faultWorkers: fanOut, rounds, samples, medians, serialRatio: medians.after / medians.before, fanOutRatio: medians.fanout / medians.before };
}
