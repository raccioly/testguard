import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport, argvFor, owns, testGlobs, tests, makeCheck, chooseEngine, environment, resetInterpreterCache, PYTHON_DIR } from '../src/probe/runners/python.mjs';
import { RUNNERS, OWNED_RUNNERS, partitionByRunner, runnerFor, mergeRuns, selectRunner } from '../src/probe/runners/index.mjs';
import * as vitest from '../src/probe/runners/vitest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (f) => JSON.parse(readFileSync(join(ROOT, 'test', 'samples', f), 'utf8'));

afterEach(() => resetInterpreterCache());

describe('the Python report maps onto the spec testRun', () => {
  it('counts an assertion failure and a raised exception alike, and a timeout as neither', () => {
    const { run, timeouts, failedTests } = parseReport(sample('python-report.json'), 250);
    expect(run.outcome).toBe('fail');
    // 7 tests; passed = 1; failed counts the three `failed` plus the xpass.
    expect(run.tests).toEqual({ total: 7, passed: 1, failed: 4 });
    // AssertionError and TypeError both kill; the pytest-timeout failure does not.
    expect(run.assertionFailures).toBe(2);
    expect(timeouts).toBe(1);
    expect(failedTests).toContain('tests/test_redact.py::test_xpass');
    expect(failedTests).toHaveLength(4);
  });

  it('an id splits on :: to the file, which is what escalation attributes a killer by', () => {
    const { failedTests } = parseReport(sample('python-report.json'), 1);
    expect(failedTests.map((t) => t.split('::')[0])).toEqual(
      ['tests/test_redact.py', 'tests/test_redact.py', 'tests/test_slow.py', 'tests/test_redact.py'],
    );
  });

  it('a collection error is a load failure whose message names the cause, never a kill', () => {
    const { run, loadMessage } = parseReport(sample('python-report-collect-error.json'), 40);
    expect(run.outcome).toBe('error');
    expect(run.assertionFailures).toBe(0);
    // classify() reads this string to tell `replacement-does-not-compile` from `suite-failed-to-load`.
    expect(loadMessage).toMatch(/SyntaxError/);
    expect(/syntax|parse|transform failed|expected .+ but found|unexpected token/i.test(loadMessage)).toBe(true);
  });

  it('collecting nothing is an error, never a pass', () => {
    const { run, loadMessage } = parseReport({ testguard: 1, tests: [], collectionErrors: [] }, 10);
    expect(run.outcome).toBe('error');
    expect(loadMessage).toBe('python collected no tests');
  });

  it('a green run is green, and an xpass alone is not', () => {
    const green = { testguard: 1, collectionErrors: [], tests: [{ id: 'a::b', outcome: 'passed' }, { id: 'a::c', outcome: 'skipped' }, { id: 'a::d', outcome: 'xfail' }] };
    expect(parseReport(green, 1).run.outcome).toBe('pass');
    const xp = { ...green, tests: [...green.tests, { id: 'a::e', outcome: 'xpass' }] };
    const r = parseReport(xp, 1);
    expect(r.run.outcome).toBe('fail');
    expect(r.run.assertionFailures).toBe(0); // not green, but nothing asserted: it can never be a kill
  });

  it('carries provenance through, which is what the import check reads', () => {
    expect(parseReport(sample('python-report.json'), 1).provenance).toEqual({ 'demo/redact.py': '/tmp/project/demo/redact.py' });
    expect(parseReport({ testguard: 1, tests: [{ id: 'a::b', outcome: 'passed' }] }, 1).provenance).toEqual({});
  });
});

describe('the command line', () => {
  it('always neutralises a project addopts `-x`, because it would truncate the failing-test list', () => {
    const argv = argvFor({ engine: 'pytest', interpreter: '/v/bin/python', files: ['tests/test_a.py'], serial: false });
    expect(argv).toContain('--maxfail=0');
    expect(argv).toEqual(['/v/bin/python', '-m', 'pytest', '-p', '_testguard_pytest_plugin', '-p', 'no:cacheprovider', '--maxfail=0', '-q', 'tests/test_a.py']);
  });
  it('serial disables xdist; unittest runs the injected module and takes files as arguments', () => {
    expect(argvFor({ engine: 'pytest', interpreter: 'p', files: ['a.py'], serial: true })).toEqual(
      ['p', '-m', 'pytest', '-p', '_testguard_pytest_plugin', '-p', 'no:cacheprovider', '--maxfail=0', '-q', '-p', 'no:xdist', 'a.py'],
    );
    expect(argvFor({ engine: 'unittest', interpreter: 'p', files: ['a.py', 'b.py'] })).toEqual(['p', '-m', '_testguard_unittest_main', 'a.py', 'b.py']);
  });
});

describe('ownership and selection', () => {
  it('owns every .py file and nothing else — a Python test can never run under vitest', () => {
    expect(owns('/p', 'tests/test_a.py')).toBe(true);
    expect(owns('/p', 'src/pkg/mod.py')).toBe(true);
    expect(owns('/p', 'test/a.test.mjs')).toBe(false);
  });

  it('collects pytest and unittest naming conventions', () => {
    expect(testGlobs).toContain('**/test_*.py');
    expect(testGlobs).toContain('**/*_test.py');
    const dir = mkdtempSync(join(tmpdir(), 'tg-pyglob-'));
    mkdirSync(join(dir, 'tests'));
    for (const f of ['tests/test_a.py', 'tests/b_test.py', 'tests/conftest.py', 'tests/helper.txt']) writeFileSync(join(dir, f), '');
    expect(tests(dir)).toEqual(['tests/b_test.py', 'tests/test_a.py']);
  });

  it('a .py defender runs under python whatever the project runner is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pypart-'));
    const groups = partitionByRunner(dir, ['test/unit.test.mjs', 'tests/test_a.py'], vitest);
    expect([...groups].map(([r, files]) => [r.name, files])).toEqual([['vitest', ['test/unit.test.mjs']], ['python', ['tests/test_a.py']]]);
    expect(runnerFor(dir, 'tests/test_a.py', vitest).name).toBe('python');
    expect(OWNED_RUNNERS.map((r) => r.name)).toContain('python');
  });

  it('exposes pytest and unittest as engine-pinned runners, and rejects anything else', async () => {
    expect(RUNNERS.pytest.name).toBe('pytest');
    expect(RUNNERS.unittest.name).toBe('unittest');
    expect((await selectRunner({ projectDir: ROOT, name: 'mocha' })).error).toMatch(/unknown runner/);
  });
});

describe('the interpreter is a precondition, never a verdict', () => {
  it('resolves an interpreter and reports the engine it will use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pycheck-'));
    const c = await makeCheck('unittest')({ projectDir: dir });
    expect(c.ok).toBe(true);
    expect(c.engine).toBe('unittest');
    expect(c.version).toMatch(/^CPython \d+\.\d+/);
  }, 40_000);

  it('a pinned pytest on an interpreter that cannot import it is a precondition failure, never unittest', () => {
    // The branch that matters: the interpreter RESOLVES, and still has no
    // pytest. Falling back would put an engine in the evidence that never ran.
    const bare = { path: '/v/bin/python', python: '3.12.0', pytest: null };
    const withPytest = { path: '/v/bin/python', python: '3.12.0', pytest: '9.1.1' };
    expect(chooseEngine('pytest', bare)).toMatchObject({ ok: false });
    expect(chooseEngine('pytest', bare).message).toMatch(/pytest is not importable/);
    expect(chooseEngine('pytest', withPytest)).toMatchObject({ ok: true, engine: 'pytest', version: '9.1.1' });
  });

  it('auto picks pytest when it is importable and the stdlib runner when it is not', () => {
    expect(chooseEngine(null, { path: 'p', python: '3.12.0', pytest: '9.1.1' })).toMatchObject({ engine: 'pytest' });
    expect(chooseEngine(null, { path: 'p', python: '3.12.0', pytest: null }))
      .toMatchObject({ ok: true, engine: 'unittest', version: 'CPython 3.12.0' });
    // unittest is never refused for lacking pytest — it is the stdlib.
    expect(chooseEngine('unittest', { path: 'p', python: '3.12.0', pytest: null })).toMatchObject({ ok: true });
  });

  it('an interpreter that does not resolve at all is a precondition failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pypin-'));
    const c = await makeCheck('pytest')({ projectDir: dir, python: join(dir, 'no-such-python') });
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/not a usable Python interpreter/);
  }, 40_000);

  it('an unresolvable runner returns a message instead of running anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pynone-'));
    const r = await RUNNERS.python.run({ projectDir: dir, python: join(dir, 'nope'), files: ['tests/test_a.py'], budgetMs: 5000 });
    expect(r.run.outcome).toBe('error');
    expect(r.run.assertionFailures).toBe(0);
    expect(r.loadMessage).toMatch(/interpreter/);
  }, 40_000);

  it('ships the injected reporters inside the package, never into the project', () => {
    for (const f of ['_testguard_report.py', '_testguard_pytest_plugin.py', '_testguard_unittest_main.py']) {
      expect(readFileSync(join(PYTHON_DIR, f), 'utf8').length).toBeGreaterThan(0);
    }
  });
});

describe('a stale .pyc cannot hide a fault', () => {
  /**
   * `.pyc` validation is the source's mtime in WHOLE SECONDS plus its size. A
   * fault that preserves the byte length and lands within the same second as
   * the file it replaced is therefore served from cache and never executes: a
   * green run that proves nothing, which is a false `survived`.
   *
   * This test demonstrates the hazard first — otherwise it would pass just as
   * well if the mitigation did nothing.
   */
  const run = (cwd, env) => spawnSync('python3', ['use.py'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();

  it('the cache prefix bypasses a __pycache__ that would otherwise serve the old bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pyc-'));
    writeFileSync(join(dir, 'use.py'), 'import m\nprint(m.VALUE)\n');
    writeFileSync(join(dir, 'm.py'), 'VALUE = "AAA"\n');
    expect(run(dir, {})).toBe('AAA'); // warms __pycache__ in the tree

    // Same byte length, same second: exactly what a length-preserving fault does.
    writeFileSync(join(dir, 'm.py'), 'VALUE = "CCC"\n');
    const cache = join(dir, 'fresh-cache');
    expect(run(dir, { PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: cache })).toBe('CCC');
    expect(existsSync(cache)).toBe(false); // nothing written, so nothing can go stale here either
  }, 30_000);

  it('the runner sets both on every run, with a prefix unique to that run', () => {
    const env = environment(['demo/redact.py']);
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
    // {out} is the per-run report path, so no two runs share a cache location.
    expect(env.PYTHONPYCACHEPREFIX).toBe('{out}.pycache');
    expect(env.TESTGUARD_REPORT).toBe('{out}');
    expect(JSON.parse(env.TESTGUARD_TARGETS)).toEqual(['demo/redact.py']);
    expect(env.PYTHONPATH.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(PYTHON_DIR);
  });
});

describe('mergeRuns keeps provenance across runners', () => {
  it('merges each runner s provenance, since only one reports any per target', () => {
    const part = (extra) => ({ run: { outcome: 'pass', tests: { total: 1, passed: 1, failed: 0 }, assertionFailures: 0, durationMs: 1 }, timeouts: 0, failedTests: [], ...extra });
    const merged = mergeRuns([part({ provenance: {} }), part({ provenance: { 'a.py': '/iso/a.py' } })]);
    expect(merged.provenance).toEqual({ 'a.py': '/iso/a.py' });
  });
});
