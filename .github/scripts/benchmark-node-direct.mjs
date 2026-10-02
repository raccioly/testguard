#!/usr/bin/env node
// Same fixture commit and recipes, N=3, fresh workers, no reused verdicts.
// Warmups excluded; ABBA timing is informational, mismatched proof fails.
// Run without competing test processes. Keep the receipt directory for audit.
// node .github/scripts/benchmark-node-direct.mjs --before-ref <SHA> --out <dir>
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { probe as after } from '../../src/probe/probe.mjs';
import { readSpecDoc, writeSpecDoc } from '../../src/evidence/writer.mjs';
import { detectContention } from '../../src/probe/contention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, 'before-ref': { type: 'string' } } });
assert(values.out && /^[0-9a-f]{40}$/.test(values['before-ref'] ?? ''), '--out and an exact --before-ref commit SHA are required');
const out = resolve(values.out);
mkdirSync(out, { recursive: true, mode: 0o700 });
mkdirSync(join(out, 'workers'), { mode: 0o700 }); // Refuse to overwrite a previous study.
const tool = mkdtempSync(join(tmpdir(), 'tg-direct-reference-'));
const dir = mkdtempSync(join(tmpdir(), 'tg-direct-bench-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000 }).trim();
const projection = (record) => ({
  id: record.claim.id + '/' + record.subject.id,
  subject: record.subject,
  verdict: record.verdict,
  reason: record.detail.reason ?? null,
  defenders: record.defenders,
  targetHash: record.inputs?.targetHash,
  defenderHashes: record.inputs?.defenderHashes,
  discoveryHashes: record.inputs?.discoveryHashes,
  baseline: (record.detail.baselineRuns ?? []).map(({ durationMs, ...run }) => run),
  probe: (record.detail.probeRuns ?? []).map(({ durationMs, ...run }) => run),
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
    const evidence = await ({ before, after }[strategy])({ projectDir: dir, claims, runnerName: 'node-test', confirmRuns: 3, workers: 1, serial: true, budgetMs: 10000, escalate: false });
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
        assert(record.detail.probeRuns.every((run) => run.outcome === 'fail' && run.assertionFailures > 0));
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
  const mean = (strategy) => results.filter((result) => result.strategy === strategy).reduce((sum, result) => sum + result.elapsedMs, 0) / 2;
  const summary = {
    version: process.versions.node,
    toolHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    beforeRef: values['before-ref'], head,
    beforeMs: mean('before'), afterMs: mean('after'), speedup: mean('before') / mean('after'),
    verifiedOutcomes: 40, results,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tool, { recursive: true, force: true });
}
