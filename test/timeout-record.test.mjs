// The probe's timeout record says what the machine was doing (#310). One real probe, two tiny processes.
import { afterEach, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUDGET_GRACE_MS } from '../src/probe/runners/shared.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'testguard.mjs');
let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

it('the record says the run ended at the budget and that other runners were busy, and stays a timeout', async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-record-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bound', private: true, type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  writeFileSync(join(dir, 'src/hang.mjs'), 'export const hang = () => 1;\n');
  writeFileSync(join(dir, 'test/hang.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { hang } from '../src/hang.mjs';\ntest('hang', () => { assert.equal(hang(), 1); });\n");
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({
    schemaVersion: 1,
    claims: [{ id: 'HANG', statement: 'hang holds.', source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: ['test/hang.test.mjs'],
      faults: [{ id: 'F1', description: 'the subject never returns', faultClass: 'return-altered', file: 'src/hang.mjs', find: '=> 1', replace: '=> { for (;;) {} }', producedBy: { producer: 'human' } }] }],
  }));
  const git = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // Another test runner, busy on this machine: its command line names one. Killed by pid below.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'vitest', 'decoy'], { stdio: 'ignore' });
  try {
    await new Promise((done) => setTimeout(done, 150));
    const out = join(dir, 'evidence.json');
    const run = spawnSync(process.execPath, [CLI, 'probe', dir, '--runner', 'node-test', '--confirm', '1', '--budget', '1500', '--no-escalate', '--quiet', '--out', out], { encoding: 'utf8', timeout: 60_000 });
    expect(existsSync(out), run.stderr).toBe(true);
    const record = JSON.parse(readFileSync(out, 'utf8')).records[0];
    expect(record.verdict).toBe('timeout');
    expect(record.detail.reason).toBe('test-timed-out');
    expect(record.detail.message).toMatch(/^budget of 1500ms exceeded; the run ended there and its teardown was given 5000ms; every process of its tree was confirmed dead/);
    expect(record.detail.message).toMatch(/other test runners? (was|were) busy on this machine when the run timed out.*environment condition/);
    expect(record.detail.probeRuns.every((r) => r.durationMs <= 1500 + BUDGET_GRACE_MS)).toBe(true);
  } finally {
    try { decoy.kill('SIGKILL'); } catch {}
  }
}, 90_000);
