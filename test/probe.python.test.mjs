import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { resetInterpreterCache } from '../src/probe/runners/python.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer-python');
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

// The interpreter TestGuard will resolve, so capability detection and the run
// cannot disagree. CI points TESTGUARD_PYTHON at a bare venv to prove the
// stdlib path without depending on what the runner image happens to ship.
const PYTHON = process.env.TESTGUARD_PYTHON || 'python3';
const which = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }).status === 0;
const HAS_PYTHON = which(PYTHON, ['-c', 'import sys']);
// pytest is optional: the stdlib engine is the one that must always work, and
// the point of it is that a project with no test dependencies still probes.
const HAS_PYTEST = HAS_PYTHON && which(PYTHON, ['-c', 'import pytest']);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

function plant() {
  const scratch = mkdtempSync(join(tmpdir(), 'testguard-python-'));
  cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/__pycache__|\.flake-counter|\.testguard|\.pytest_cache/.test(src) });
  git(scratch, 'init', '-q');
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-q', '-m', 'fixture');
  return scratch;
}

const verdicts = (evidence) => Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }]));
const wanted = (actual) => Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? actual[k]?.reason }]));

/**
 * The Python edition of the acceptance test: the same oracle as every other
 * fixture, and every expectation in expected.json was verified by applying the
 * fault by hand and reading `python -m unittest`'s own exit code, not
 * TestGuard's reporter.
 */
describe.skipIf(!HAS_PYTHON)('probe reproduces the known-answer fixture with the stdlib unittest engine', () => {
  let scratch;
  let evidence;

  beforeAll(async () => {
    resetInterpreterCache();
    scratch = plant();
    evidence = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, mode: 'worktree', runnerName: 'unittest', escalate: false, budgetMs: expected.budgetMs, toolVersion: 'test' });
  }, 600_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); resetInterpreterCache(); });

  it('records the engine that ran, not the module that hosts it', () => {
    expect(evidence.run.runner.name).toBe('unittest');
    expect(evidence.run.runner.version).toMatch(/^CPython \d+\.\d+/);
  });

  it('yields every expected verdict, with the expected reason where one is stated', () => {
    const actual = verdicts(evidence);
    expect(actual).toEqual(wanted(actual));
  });

  it('a whole-module patch is not a defender; an attribute patch is, and says which attributes', () => {
    const mocked = evidence.records.find((r) => r.claim.id === 'EXPORT-002');
    expect(mocked.verdict).toBe('nocover');
    expect(mocked.defenders.mocking).toEqual(['tests/test_export_mocked.py']);
    expect(mocked.defenders.signals).toEqual([{ file: 'tests/test_export_mocked.py', signal: 'mocked-never-asserted' }]);

    const patched = evidence.records.find((r) => r.claim.id === 'PATCHED-001');
    expect(patched.verdict).toBe('killed');
    expect(patched.defenders.resolved).toEqual(['tests/test_patched.py']);
    expect(patched.defenders.signals).toEqual([{ file: 'tests/test_patched.py', signal: 'target-attribute-patched', reason: 'demo.redact.compile_rules' }]);
  });

  it('a module the defenders never imported is unverifiable, and both signals agree', () => {
    const unreached = evidence.records.find((r) => r.claim.id === 'UNREACHED-001');
    // Not `survived`. The defenders stayed green with the subject replaced by
    // something that cannot compile, so nothing was measured about their
    // assertions and reporting a survivor would be a confident lie (#74).
    expect(unreached.verdict).toBe('unverifiable');
    expect(unreached.detail.reason).toBe('subject-not-executed');
    expect(unreached.detail.negativeControl).toBe('not-reached');
    // Python can name the file the interpreter actually loaded, which is the
    // same finding reported more precisely. The two may never disagree, and a
    // validator rule makes a document where they do invalid.
    expect(unreached.detail.targetNotImported).toBe(true);
    // A fault whose replacement does not parse leaves nothing imported either;
    // that is explained by the load failure and must not be flagged as reach.
    // It is also not a survivor, so it is never charged for a control at all.
    const invalid = evidence.records.find((r) => r.claim.id === 'REDACT-006');
    expect(invalid.detail.targetNotImported).toBeUndefined();
    expect(invalid.detail.negativeControl).toBeUndefined();
  });

  it('discovers defenders by Python module name when none is declared', () => {
    const discovered = evidence.records.find((r) => r.claim.id === 'DISCOVER-001');
    expect(discovered.defenders.discovered).toBe(true);
    expect(discovered.defenders.resolved.sort()).toEqual(['tests/test_patched.py', 'tests/test_redact.py']);
    expect(discovered.verdict).toBe('killed');
  });

  it('ranks by a blast radius measured over Python imports', () => {
    expect(evidence.records.find((r) => r.subject.file === 'demo/redact.py').rank.blastRadius).toBe(1);
  });

  it('emits evidence that conforms', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });
});

describe.skipIf(!HAS_PYTEST)('the same oracle under pytest', () => {
  let scratch;
  let evidence;

  beforeAll(async () => {
    resetInterpreterCache();
    scratch = plant();
    evidence = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, mode: 'worktree', runnerName: 'pytest', escalate: false, budgetMs: expected.budgetMs, toolVersion: 'test' });
  }, 600_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); resetInterpreterCache(); });

  it('reaches the same verdicts through a different engine and a different report shape', () => {
    expect(evidence.run.runner.name).toBe('pytest');
    const actual = verdicts(evidence);
    expect(actual).toEqual(wanted(actual));
  });
});

/**
 * The control the green baseline cannot provide. A scratch worktree isolates
 * Node for free; Python can still load the original file, and then every
 * verdict is `survived` on a green baseline — false in the one direction
 * nothing else catches.
 */
describe.skipIf(!HAS_PYTHON)('a fault the interpreter never loads is refused, not reported', () => {
  let scratch;
  let outside;

  beforeEach(() => {
    resetInterpreterCache();
    outside = mkdtempSync(join(tmpdir(), 'testguard-outside-'));
    mkdirSync(join(outside, 'demo'));
    writeFileSync(join(outside, 'demo', '__init__.py'), '');
    writeFileSync(join(outside, 'demo', 'guard.py'), 'def allowed(role):\n    return role == "admin"\n');

    scratch = mkdtempSync(join(tmpdir(), 'testguard-shadow-'));
    mkdirSync(join(scratch, 'demo'));
    mkdirSync(join(scratch, 'tests'));
    writeFileSync(join(scratch, 'demo', '__init__.py'), '');
    writeFileSync(join(scratch, 'demo', 'guard.py'), 'def allowed(role):\n    return role == "admin"\n');
    // Stands in for a strict editable install: the module is resolved from a
    // directory outside the tree being probed, before the tree itself.
    writeFileSync(join(scratch, 'tests', 'test_guard.py'), [
      'import sys, unittest',
      `sys.path.insert(0, ${JSON.stringify(outside)})`,
      'from demo.guard import allowed',
      '',
      'class T(unittest.TestCase):',
      '    def test_admin(self):',
      '        self.assertTrue(allowed("admin"))',
      '    def test_other(self):',
      '        self.assertFalse(allowed("guest"))',
    ].join('\n'));
    writeFileSync(join(scratch, 'testguard.claims.json'), JSON.stringify({
      schemaVersion: 1,
      claims: [{
        id: 'GUARD-001',
        statement: 'Only an administrator is allowed.',
        source: { kind: 'spec', ref: 'README.md' },
        severity: 'critical',
        producedBy: { producer: 'human', by: 'test' },
        defendedBy: ['tests/test_guard.py'],
        faults: [{ id: 'F1', description: 'The role check always allows.', faultClass: 'guard-removed', file: 'demo/guard.py', find: 'return role == "admin"', replace: 'return True', producedBy: { producer: 'human', by: 'test' } }],
      }],
    }));
    git(scratch, 'init', '-q');
    git(scratch, 'add', '-A');
    git(scratch, 'commit', '-q', '-m', 'shadowed');
  });

  afterAll(() => { resetInterpreterCache(); });

  it('refuses the run and names the file that was loaded instead', async () => {
    await expect(probe({
      projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')),
      confirmRuns: 1, mode: 'worktree', runnerName: 'unittest', escalate: false, budgetMs: 30_000, toolVersion: 'test',
    })).rejects.toThrow(PreconditionError);

    // …and the reason is actionable, not just a refusal.
    const failure = await probe({
      projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')),
      confirmRuns: 1, mode: 'worktree', runnerName: 'unittest', escalate: false, budgetMs: 30_000, toolVersion: 'test',
    }).catch((e) => e);
    expect(failure.message).toContain(join(outside, 'demo', 'guard.py'));
    expect(failure.message).toMatch(/every claim would be reported as SURVIVED/);
  }, 300_000);

  it('without the check this suite would report SURVIVED: the fault genuinely kills when it is the code that runs', () => {
    // Same fault, applied where the tests actually import from: two tests, one fails.
    const original = readFileSync(join(outside, 'demo', 'guard.py'), 'utf8');
    writeFileSync(join(outside, 'demo', 'guard.py'), original.replace('return role == "admin"', 'return True'));
    const red = spawnSync('python3', ['-m', 'unittest', 'tests.test_guard'], { cwd: scratch, encoding: 'utf8' });
    writeFileSync(join(outside, 'demo', 'guard.py'), original);
    expect(red.status).not.toBe(0);

    // Applied in the tree being probed, the very same fault changes nothing.
    const inTree = readFileSync(join(scratch, 'demo', 'guard.py'), 'utf8');
    writeFileSync(join(scratch, 'demo', 'guard.py'), inTree.replace('return role == "admin"', 'return True'));
    const green = spawnSync('python3', ['-m', 'unittest', 'tests.test_guard'], { cwd: scratch, encoding: 'utf8' });
    writeFileSync(join(scratch, 'demo', 'guard.py'), inTree);
    expect(green.status).toBe(0);
  }, 60_000);
});
