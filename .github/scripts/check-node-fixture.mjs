#!/usr/bin/env node
// No test-framework dependencies: this also verifies the exact Node20.0.0 floor.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpecDoc } from '../../src/evidence/writer.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'tg-native-oracle-'));
try {
  cpSync(join(root, 'fixtures/known-answer-node'), scratch, { recursive: true });
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: scratch, timeout: 5000 });
  const result = spawnSync(process.execPath, [join(root, 'cli/testguard.mjs'), 'probe', scratch, '--runner', 'node-test', '--budget', '10000', '--quiet'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 1, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  const evidence = readSpecDoc('evidence', join(scratch, '.testguard/evidence.json'));
  const expected = JSON.parse(readFileSync(join(root, 'fixtures/known-answer-node/expected.json'), 'utf8')).expected;
  assert.deepStrictEqual(evidence.run.runner, { name: 'node-test', source: 'builtin', version: process.versions.node });
  assert.equal(evidence.records.length, Object.keys(expected).length);
  for (const record of evidence.records) {
    const oracle = expected[`${record.claim.id}/${record.subject.id}`];
    assert(oracle); assert.equal(record.verdict, oracle.verdict);
    if (oracle.reason) assert.equal(record.detail.reason, oracle.reason);
  }
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf8' }), '');
  console.log(`native Node ${process.versions.node}: all ${evidence.records.length} independently verified verdicts match; targets restored`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
