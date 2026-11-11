// @req FR-10
// The kill kind, measured by the real runners. For every runner there are
// three claims, each over its own function of one source file: a defender that
// asserts a value (f), a defender that never asserts anything, it only calls
// the code (g), and a defender whose only check is "does not throw" (h). Two
// faults are used: one changes the result, one makes the function throw.
//
//   WRONG fault in f vs the value-asserting defender   -> killed, killKind: assertion
//   THROW fault in g vs the defender with no assertion -> killed, killKind: exception-only
//   THROW fault in h vs the does-not-throw defender    -> killed, killKind: assertion
//
// All three claims name all three defender files, so the unmodified baseline is
// measured once for the three of them (it is cached per defender set) instead of
// once per claim. Each fault breaks one function and so turns exactly one
// defender red: the kind each defender produces is not blurred by the others.
//
// The expectations were derived by hand: apply the fault, run the runner on
// the defender, read whether an assertion or a bare exception failed it.
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { resetConfigCache } from '../src/probe/runners/playwright.mjs';
import { resetInterpreterCache } from '../src/probe/runners/python.mjs';
import { evaluateAssertionPolicy } from '../src/probe/assertion-policy.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PW_FIXTURE = join(ROOT, 'fixtures', 'known-answer-playwright');
const PYTHON = process.env.TESTGUARD_PYTHON || 'python3';
const has = (args) => spawnSync(PYTHON, args, { encoding: 'utf8' }).status === 0;
const HAS_PYTHON = has(['-c', 'import sys']);
const HAS_PYTEST = HAS_PYTHON && has(['-c', 'import pytest']);
const HAS_PLAYWRIGHT = existsSync(join(PW_FIXTURE, 'node_modules', '@playwright', 'test'));

const js = (find, replace) => ({ find, replace });
// f returns x + 1, g x + 2, h x + 3: each body is a unique anchor.
const FAULTS = {
  js: { wrong: js('  return x + 1;', '  return x + 9;'), crash: js('  return x + 2;', "  throw new Error('boom');"), notthrow: js('  return x + 3;', "  throw new Error('boom');") },
  py: { wrong: js('    return x + 1', '    return x + 9'), crash: js('    return x + 2', "    raise RuntimeError('boom')"), notthrow: js('    return x + 3', "    raise RuntimeError('boom')") },
};

const SRC_MJS = 'export function f(x) {\n  return x + 1;\n}\nexport function g(x) {\n  return x + 2;\n}\nexport function h(x) {\n  return x + 3;\n}\n';
const SRC_CJS = 'exports.f = function f(x) {\n  return x + 1;\n};\nexports.g = function g(x) {\n  return x + 2;\n};\nexports.h = function h(x) {\n  return x + 3;\n};\n';
const SRC_PY = 'def f(x):\n    return x + 1\n\n\ndef g(x):\n    return x + 2\n\n\ndef h(x):\n    return x + 3\n';

/** One runner = one project layout. `tests` maps the three defenders to files. */
const RUNNERS = {
  vitest: {
    runnerName: 'vitest', fault: 'js', source: ['src/f.mjs', SRC_MJS],
    files: {
      'package.json': '{"name":"kk","private":true,"type":"module"}\n',
      'test/assert.test.mjs': "import { test, expect } from 'vitest';\nimport { f } from '../src/f.mjs';\ntest('adds', () => { expect(f(1)).toBe(2); });\n",
      'test/crash.test.mjs': "import { test } from 'vitest';\nimport { g } from '../src/f.mjs';\ntest('runs', () => { g(1); });\n",
      'test/notthrow.test.mjs': "import { test, expect } from 'vitest';\nimport { h } from '../src/f.mjs';\ntest('does not throw', () => { expect(() => h(1)).not.toThrow(); });\n",
    },
    link: () => join(ROOT, 'node_modules'),
  },
  jest: {
    runnerName: 'jest', fault: 'js', source: ['src/f.js', SRC_CJS],
    files: {
      'package.json': '{"name":"kk","private":true}\n',
      'jest.config.js': "module.exports = { testMatch: ['**/test/*.test.js'] };\n",
      'test/assert.test.js': "const { f } = require('../src/f');\ntest('adds', () => { expect(f(1)).toBe(2); });\n",
      'test/crash.test.js': "const { g } = require('../src/f');\ntest('runs', () => { g(1); });\n",
      'test/notthrow.test.js': "const assert = require('node:assert');\nconst { h } = require('../src/f');\ntest('does not throw', () => { assert.doesNotThrow(() => h(1)); });\n",
    },
    link: () => join(ROOT, 'node_modules'),
  },
  'node-test': {
    runnerName: 'node-test', fault: 'js', source: ['src/f.mjs', SRC_MJS],
    files: {
      'package.json': '{"name":"kk","private":true,"type":"module"}\n',
      'test/assert.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { f } from '../src/f.mjs';\ntest('adds', () => { assert.strictEqual(f(1), 2); });\n",
      'test/crash.test.mjs': "import test from 'node:test';\nimport { g } from '../src/f.mjs';\ntest('runs', () => { g(1); });\n",
      'test/notthrow.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { h } from '../src/f.mjs';\ntest('does not throw', () => { assert.doesNotThrow(() => h(1)); });\n",
    },
  },
  playwright: {
    skip: !HAS_PLAYWRIGHT, runnerName: 'playwright', fault: 'js', source: ['src/f.js', SRC_CJS],
    files: {
      'package.json': '{"name":"kk","private":true}\n',
      'playwright.config.js': "module.exports = { testDir: 'e2e', testMatch: '*.spec.js' };\n",
      'e2e/assert.spec.js': "const { test, expect } = require('@playwright/test');\nconst { f } = require('../src/f');\ntest('adds', () => { expect(f(1)).toBe(2); });\n",
      'e2e/crash.spec.js': "const { test } = require('@playwright/test');\nconst { g } = require('../src/f');\ntest('runs', () => { g(1); });\n",
      'e2e/notthrow.spec.js': "const { test, expect } = require('@playwright/test');\nconst { h } = require('../src/f');\ntest('does not throw', () => { expect(() => h(1)).not.toThrow(); });\n",
    },
    link: () => join(PW_FIXTURE, 'node_modules'),
    reset: resetConfigCache,
  },
  unittest: {
    skip: !HAS_PYTHON, runnerName: 'unittest', fault: 'py', source: ['f.py', SRC_PY],
    files: {
      'tests/test_assert.py': 'import unittest\nfrom f import f\n\nclass T(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(f(1), 2)\n',
      'tests/test_crash.py': 'import unittest\nfrom f import g\n\nclass T(unittest.TestCase):\n    def test_runs(self):\n        g(1)\n',
      'tests/test_notthrow.py': 'import unittest\nfrom f import h\n\nclass T(unittest.TestCase):\n    def test_does_not_throw(self):\n        try:\n            h(1)\n        except Exception as e:\n            self.fail("raised %r" % e)\n',
    },
  },
  pytest: {
    skip: !HAS_PYTEST, runnerName: 'pytest', fault: 'py', source: ['f.py', SRC_PY],
    files: {
      'conftest.py': '',
      'tests/test_assert.py': 'from f import f\n\ndef test_adds():\n    assert f(1) == 2\n',
      'tests/test_crash.py': 'from f import g\n\ndef test_runs():\n    g(1)\n',
      'tests/test_notthrow.py': 'import pytest\nfrom f import h\n\ndef test_does_not_throw():\n    try:\n        h(1)\n    except Exception as e:\n        pytest.fail("raised %r" % e)\n',
    },
  },
};

const defender = (cfg, kind) => Object.keys(cfg.files).find((p) => p.includes(kind) && !p.endsWith('.json') && !p.endsWith('config.js'));

function claimsFor(cfg) {
  const f = FAULTS[cfg.fault];
  const producedBy = { producer: 'agent', by: 'test' };
  // The same defender set on every claim, in the same order: one baseline measurement serves all three.
  const defendedBy = ['assert', 'crash', 'notthrow'].map((kind) => defender(cfg, kind));
  const claim = (id, fault, name) => ({
    id, statement: `f behaves (${name}).`, source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy,
    defendedBy,
    faults: [{ id: 'F1', description: name, faultClass: 'other', file: cfg.source[0], ...fault, producedBy }],
  });
  return { schemaVersion: 1, claims: [
    claim('KK-ASSERT', f.wrong, 'wrong result'),
    claim('KK-CRASH', f.crash, 'throws'),
    claim('KK-NOTTHROW', f.notthrow, 'throws, defender asserts it does not'),
  ] };
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

const scratches = [];
afterAll(() => { for (const d of scratches) rmSync(d, { recursive: true, force: true }); });

for (const [name, cfg] of Object.entries(RUNNERS)) {
  describe.skipIf(cfg.skip)(`kill kind: ${name}`, () => {
    let evidence;
    it('probes the three claims', async () => {
      const dir = mkdtempSync(join(tmpdir(), `tg-killkind-${name}-`));
      scratches.push(dir);
      const all = { ...cfg.files, [cfg.source[0]]: cfg.source[1] };
      for (const [p, content] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), content); }
      if (cfg.link) symlinkSync(cfg.link(), join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, '.gitignore'), 'node_modules\n.testguard\n__pycache__\ntest-results\n');
      git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'fixture');
      cfg.reset?.(); resetInterpreterCache();
      evidence = await probe({ projectDir: dir, claims: claimsFor(cfg), confirmRuns: 3, mode: 'worktree', runnerName: cfg.runnerName, python: HAS_PYTHON ? PYTHON : undefined, escalate: false, budgetMs: 60_000, toolVersion: 'test' });
      expect(validate('evidence', evidence).errors).toEqual([]);
    }, 300_000);

    const kind = (id) => evidence.records.find((r) => r.claim.id === id);
    it('a defender that asserts a value kills a wrong result by assertion', () => {
      expect(kind('KK-ASSERT').verdict).toBe('killed');
      expect(kind('KK-ASSERT').detail.killKind).toBe('assertion');
    });
    it('a defender with no assertion still kills a throwing fault (default verdict unchanged) but only by exception', () => {
      const r = kind('KK-CRASH');
      expect(r.verdict).toBe('killed');
      expect(r.detail.killKind).toBe('exception-only');
      expect(r.detail.probeRuns.every((x) => x.assertionFailures === 0 && x.exceptionFailures > 0)).toBe(true);
    });
    it('a does-not-throw check on a throwing fault is an assertion', () => {
      expect(kind('KK-NOTTHROW').verdict).toBe('killed');
      expect(kind('KK-NOTTHROW').detail.killKind).toBe('assertion');
    });
    it('the policy names exactly the exception-only kill', () => {
      expect(evaluateAssertionPolicy(evidence.records)).toEqual({ state: 'failed', exceptionOnlyKills: [{ claimId: 'KK-CRASH', faultId: 'F1' }] });
    });
  });
}
