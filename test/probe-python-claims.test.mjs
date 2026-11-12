// The two Python-engine behaviours test/probe.python.test.mjs kills faults for, measured on their own: a
// replacement that does not compile is `fault-invalid`, never a kill, and a defender that patches only an
// attribute of the target is still a defender. The full known-answer probe (about 20 s a run, far over the
// 100 s per-claim ceiling once a self-probe repeats it) stays the acceptance oracle; this probes the two
// fixture claims alone, a second or two a run, so claims can name it as their defender.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { resetInterpreterCache } from '../src/probe/runners/python.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-answer-python');
const PYTHON = process.env.TESTGUARD_PYTHON || 'python3';
const HAS_PYTHON = spawnSync(PYTHON, ['-c', 'import sys']).status === 0;

const git = (cwd, ...args) => {
  const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

describe.skipIf(!HAS_PYTHON)('the unittest engine on the two fixture claims that need no hang', () => {
  let scratch;
  let evidence;

  beforeAll(async () => {
    resetInterpreterCache();
    scratch = mkdtempSync(join(tmpdir(), 'testguard-python-claims-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/__pycache__|\.flake-counter|\.testguard|\.pytest_cache/.test(src) });
    git(scratch, 'init', '-q');
    git(scratch, 'add', '-A');
    git(scratch, 'commit', '-q', '-m', 'fixture');
    evidence = await probe({
      projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), only: ['REDACT-006', 'PATCHED-001'],
      confirmRuns: 1, mode: 'worktree', runnerName: 'unittest', escalate: false, budgetMs: 30_000, toolVersion: 'test',
    });
  }, 120_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); resetInterpreterCache(); });

  it('a replacement that does not compile is fault-invalid: a collection error is never a kill', () => {
    const invalid = evidence.records.find((r) => r.claim.id === 'REDACT-006');
    expect(invalid.verdict).toBe('fault-invalid');
    expect(invalid.detail.reason).toBe('replacement-does-not-compile');
  });

  it('a defender that patches only an attribute of the target is still a defender, and says which attribute', () => {
    const patched = evidence.records.find((r) => r.claim.id === 'PATCHED-001');
    expect(patched.verdict).toBe('killed');
    expect(patched.defenders.resolved).toEqual(['tests/test_patched.py']);
    expect(patched.defenders.signals).toEqual([{ file: 'tests/test_patched.py', signal: 'target-attribute-patched', reason: 'demo.redact.compile_rules' }]);
  });
});
