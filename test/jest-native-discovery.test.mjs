// Issue #334, layer 2: runner-native discovery for Jest. When the static layer
// cannot say whether a test reaches the subject (a custom resolver, `modulePaths`,
// a preset, a mapper it cannot read), TestGuard asks Jest itself:
// `jest --listTests --json --findRelatedTests <target>`. The answer names the
// defenders; a failed, timed-out or unreadable answer stays indeterminate and
// is never read as "no test".
//
// Hermetic (AGENTS.md rule 12): the "jest" here is a small Node script placed
// where the project's runner resolves, answering from a JSON file. No package
// manager, no network, no real Jest.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetAliasCache } from '../src/probe/rank.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import * as jest from '../src/probe/runners/jest.mjs';
import * as vitest from '../src/probe/runners/vitest.mjs';
import { discoverDefendersDetailed } from '../src/probe/discover.mjs';
import { createNativeDiscovery, NATIVE_MAX_RUNS } from '../src/probe/native-discovery.mjs';
import { probe } from '../src/probe/probe.mjs';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './helpers/git.mjs';

const roots = [];
afterEach(() => { resetAliasCache(); resetRunnerCache(); while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const FAKE_JEST = `
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
const control = JSON.parse(fs.readFileSync(path.join(cwd, '.fake-jest.json'), 'utf8'));
fs.appendFileSync(path.join(cwd, '.fake-jest.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--runTestsByPath')) {
  const out = process.argv.find((arg) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
  const files = process.argv.slice(process.argv.indexOf('--runTestsByPath') + 1);
  const source = fs.readFileSync(path.join(cwd, 'src/price/price.js'), 'utf8');
  const unparseable = source.includes('must not parse');
  const failing = source.includes('if (false)');
  const testResults = files.map((file) => (unparseable
    ? { name: path.join(cwd, file), status: 'failed', message: 'SyntaxError: unexpected end of input', assertionResults: [] }
    : { name: path.join(cwd, file), status: failing ? 'failed' : 'passed', assertionResults: [{ title: 'labels', fullName: 'labels', ancestorTitles: [], status: failing ? 'failed' : 'passed', failureMessages: failing ? ['Error: expect(received).toBe(expected)'] : [], failureDetails: failing ? [{ matcherResult: { pass: false } }] : [] }] }));
  fs.writeFileSync(out, JSON.stringify({ success: !failing && !unparseable, numTotalTests: unparseable ? 0 : files.length, numPassedTests: failing || unparseable ? 0 : files.length, numFailedTests: failing ? files.length : 0, testResults }));
  process.exit(0);
}
const at = process.argv.indexOf('--findRelatedTests');
const target = path.relative(cwd, process.argv[at + 1] ?? '');
if (at === -1) process.stdout.write(JSON.stringify((control.all ?? ['test/price.test.js']).map((file) => path.join(cwd, file))));
else if (control.mode === 'hang') setInterval(() => {}, 1000);
else if (control.mode === 'exit1') { process.stderr.write('Error: could not resolve the resolver\\n'); process.exit(1); }
else if (control.mode === 'garbage') process.stdout.write('not json at all');
else if (control.mode === 'object') process.stdout.write('{"files":[]}');
else if (control.mode === 'badentry') process.stdout.write('[42]');
else {
  const listed = (control.related[target] ?? []).map((file) => (path.isAbsolute(file) ? file : path.join(cwd, file)));
  process.stdout.write(JSON.stringify(listed));
}
`;

const RESOLVER_CONFIG = "module.exports = { testEnvironment: 'node', resolver: './resolver.js' };\n";

function project({ control = { mode: 'ok', related: {} }, files = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-native-')));
  roots.push(root);
  for (const [name, text] of Object.entries({
    'package.json': '{ "name": "demo", "private": true }',
    'jest.config.js': RESOLVER_CONFIG,
    'resolver.js': 'module.exports = (request, options) => options.defaultResolver(request, options);\n',
    'node_modules/jest/package.json': '{ "name": "jest", "version": "30.0.0", "bin": { "jest": "bin/jest.js" } }',
    'node_modules/jest/bin/jest.js': FAKE_JEST,
    '.fake-jest.json': JSON.stringify(control),
    'src/price/price.js': "function label(price) {\n  if (price > 100) {\n    return 'expensive';\n  }\n  return 'cheap';\n}\nmodule.exports = { label };\n",
    'src/cart/cart.js': 'module.exports = { total: (a, b) => a + b };\n',
    'test/price.test.js': "const { label } = require('c/price');\ntest('labels', () => { expect(label(500)).toBe('expensive'); });\n",
    ...files,
  })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const setControl = (root, control) => writeFileSync(join(root, '.fake-jest.json'), JSON.stringify(control));
const calls = (root) => (existsSync(join(root, '.fake-jest.log')) ? readFileSync(join(root, '.fake-jest.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const TARGET = 'src/price/price.js';
const native = (root, options = {}) => createNativeDiscovery({ runner: jest, projectDir: root, ...options });
const resolveFor = (root, targetRel = TARGET, options = {}) => native(root, options).resolve(discoverDefendersDetailed(root, targetRel), targetRel);

describe('the static layer alone cannot place the test (the premise)', () => {
  it('a custom resolver makes the importing test indeterminate, never absent', () => {
    const root = project();
    const found = discoverDefendersDetailed(root, TARGET);
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
  });
});

describe('Jest answers the question the static layer could not', () => {
  it('the issue: the test Jest lists as related becomes the defender, found by runner-native discovery', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    const found = await resolveFor(root);
    expect(found.canDetect).toEqual(['test/price.test.js']);
    expect(found.indeterminate).toEqual([]);
    expect(found.discovery).toEqual({ engine: 'runner-native', runner: 'jest', files: ['test/price.test.js'] });
  });

  it('asks `jest --listTests --json --findRelatedTests <absolute target>` in the project, with the project\'s jest', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    await resolveFor(root);
    const [argv] = calls(root);
    expect(argv).toEqual(expect.arrayContaining(['--listTests', '--json', '--findRelatedTests']));
    expect(argv.at(-1)).toBe(join(root, TARGET));
    expect(argv.at(argv.indexOf('--findRelatedTests') + 1)).toBe(join(root, TARGET));
  });

  it('a test Jest does not list is answered "not related": it leaves the indeterminate set', async () => {
    const root = project({
      control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } },
      files: { 'test/cart.test.js': "const { total } = require('c/cart');\ntest('t', () => { expect(total(1, 2)).toBe(3); });\n" },
    });
    const detailed = discoverDefendersDetailed(root, TARGET);
    expect(detailed.indeterminate.map((entry) => entry.file).sort()).toEqual(['test/cart.test.js', 'test/price.test.js']);
    const found = await native(root).resolve(detailed, TARGET);
    expect(found.canDetect).toEqual(['test/price.test.js']);
    expect(found.indeterminate).toEqual([]);
  });

  it('keeps only files inside the project, and only files in the configured test universe', async () => {
    const root = project({
      control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js', '/etc/hosts', '../elsewhere.test.js', 'test/other.test.js', 'test/missing.test.js'] } },
      files: { 'test/other.test.js': "require('c/other');\n" },
    });
    const universe = Object.freeze(['test/price.test.js']);
    const detailed = discoverDefendersDetailed(root, TARGET, universe);
    const found = await native(root).resolve(detailed, TARGET, universe);
    expect(found.canDetect).toEqual(['test/price.test.js']);
    expect(found.discovery.files).toEqual(['test/price.test.js']);
  });

  it('an empty answer is an answer: nothing related, so nothing is indeterminate any more', async () => {
    const root = project({ control: { mode: 'ok', related: {} } });
    const found = await resolveFor(root);
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate).toEqual([]);
  });

  it('a test that mocks the subject through a name no static rule can place stays indeterminate', async () => {
    const root = project({
      control: { mode: 'ok', related: { [TARGET]: ['test/mocked.test.js'] } },
      files: { 'test/mocked.test.js': "jest.mock('c/price');\nconst { label } = require('c/price');\ntest('t', () => { expect(label(1)).toBeUndefined(); });\n" },
    });
    const found = await resolveFor(root);
    expect(found.canDetect).not.toContain('test/mocked.test.js');
    expect(found.indeterminate.map((entry) => entry.file)).toContain('test/mocked.test.js');
  });

  it('does not touch an indeterminacy Jest cannot answer (a file this parser cannot read)', async () => {
    const root = project({
      control: { mode: 'ok', related: {} },
      files: { 'test/unparsable.test.js': "const broken = `${;\n" },
    });
    const found = await resolveFor(root);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/unparsable.test.js']);
  });
});

describe('a run that does not answer is indeterminate, never optimistic', () => {
  it.each([
    ['exits non-zero', { mode: 'exit1' }, /exited 1/],
    ['prints text that is not JSON', { mode: 'garbage' }, /not valid JSON/],
    ['prints JSON that is not a list', { mode: 'object' }, /JSON array/],
    ['lists something that is not a path', { mode: 'badentry' }, /malformed/],
  ])('Jest %s', async (_name, control, why) => {
    const root = project({ control });
    const found = await resolveFor(root);
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
    expect(found.indeterminate[0].reason).toMatch(why);
    expect(found.indeterminate[0].reason).toMatch(/runner-native/);
    expect(found.discovery).toBeUndefined();
  });

  it('a run that outlives its time budget is cut and stays indeterminate', async () => {
    const root = project({ control: { mode: 'hang' } });
    const started = Date.now();
    const found = await resolveFor(root, TARGET, { timeoutMs: 400 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate[0].reason).toMatch(/timeout/);
  });

  it('a project with no resolvable jest stays indeterminate (no network, no package manager)', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    const found = await resolveFor(root, TARGET, { timeoutMs: 2000, env: { PATH: '' } });
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
  });
});

describe('who is asked, and how often', () => {
  it('only a runner that can answer is asked', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    const found = await resolveFor(root, TARGET, { runner: vitest });
    expect(calls(root)).toEqual([]);
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
  });

  it('a result with nothing indeterminate costs no process', async () => {
    const root = project({ files: { 'jest.config.js': "module.exports = { testEnvironment: 'node' };\n", 'test/price.test.js': "const { label } = require('../src/price/price');\n" } });
    const found = await resolveFor(root);
    expect(calls(root)).toEqual([]);
    expect(found.canDetect).toEqual(['test/price.test.js']);
    expect(found.discovery).toBeUndefined();
  });

  it('answers are cached per target and discovery-config hash: parallel fan-out asks once', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    const engine = native(root);
    const detailed = discoverDefendersDetailed(root, TARGET);
    const all = await Promise.all(Array.from({ length: 6 }, () => engine.resolve(detailed, TARGET)));
    expect(calls(root)).toHaveLength(1);
    for (const found of all) expect(found.canDetect).toEqual(['test/price.test.js']);
    await engine.resolve(detailed, TARGET);
    expect(calls(root)).toHaveLength(1);
  });

  it('a changed discovery config is a new question', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } } });
    const engine = native(root);
    const detailed = discoverDefendersDetailed(root, TARGET);
    await engine.resolve(detailed, TARGET);
    writeFileSync(join(root, 'resolver.js'), 'module.exports = (request, options) => options.defaultResolver(request, options); // changed\n');
    await engine.resolve(detailed, TARGET);
    expect(calls(root)).toHaveLength(2);
  });

  it('a failed run is cached too: the same broken question is not asked twice', async () => {
    const root = project({ control: { mode: 'exit1' } });
    const engine = native(root);
    const detailed = discoverDefendersDetailed(root, TARGET);
    await engine.resolve(detailed, TARGET);
    await engine.resolve(detailed, TARGET);
    expect(calls(root)).toHaveLength(1);
  });

  it('the number of runs is bounded: past the cap a target stays indeterminate', async () => {
    const root = project({ control: { mode: 'ok', related: {} } });
    const engine = native(root, { maxRuns: 2 });
    expect(NATIVE_MAX_RUNS).toBeGreaterThan(2);
    const results = [];
    for (const target of ['src/price/price.js', 'src/cart/cart.js', 'src/price/price.js', 'src/extra.js']) {
      if (target === 'src/extra.js') writeFileSync(join(root, target), 'module.exports = {};\n');
      results.push(await engine.resolve(discoverDefendersDetailed(root, target), target));
    }
    expect(calls(root)).toHaveLength(2);
    expect(results[0].indeterminate).toEqual([]);
    expect(results[1].indeterminate).toEqual([]);
    expect(results[2].indeterminate).toEqual([]); // cached, no new run
    expect(results[3].indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
    expect(results[3].indeterminate[0].reason).toMatch(/run limit/);
  });
});

describe('the Jest adapter', () => {
  it('relatedTests returns project-relative paths, dropping anything outside the project', async () => {
    const root = project({ control: { mode: 'ok', related: { [TARGET]: ['test/price.test.js', '/etc/hosts'] } } });
    expect(await jest.relatedTests({ projectDir: root, target: TARGET })).toEqual(['test/price.test.js']);
  });

  it('exposes a discovery-config hash that moves with the config a custom resolver imports', () => {
    const root = project();
    const before = jest.discoveryConfigHash(root);
    expect(jest.discoveryConfigHash(root)).toBe(before);
    writeFileSync(join(root, 'resolver.js'), 'module.exports = () => null;\n');
    expect(jest.discoveryConfigHash(root)).not.toBe(before);
  });
});

describe('a probe uses the runner-native answer end to end', () => {
  const claims = {
    schemaVersion: 1,
    claims: [{
      id: 'PRICE', statement: 'Over 100 is expensive.', source: { kind: 'manual', ref: 'test' }, severity: 'medium', producedBy: { producer: 'human' },
      faults: [{ id: 'S1', description: 'The guard never triggers.', faultClass: 'guard-removed', file: TARGET, find: 'if (price > 100)', replace: 'if (false)', producedBy: { producer: 'human' } }],
    }],
  };
  const gitProject = (control) => {
    const root = project({ control, files: { '.gitignore': 'node_modules\n.testguard/\n.fake-jest.log\n' } });
    const git = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
    return root;
  };
  const run = (root) => probe({ projectDir: root, claims, mode: 'in-place', runnerName: 'jest', confirmRuns: 1, escalate: false, toolVersion: 't', onWarn: () => {} });

  it('the issue: a fault in the subject is killed by the test Jest lists, not reported NOCOVER', async () => {
    const root = gitProject({ mode: 'ok', related: { [TARGET]: ['test/price.test.js'] } });
    const { records } = await run(root);
    expect(records[0].verdict).toBe('killed');
    expect(records[0].defenders.resolved).toEqual(['test/price.test.js']);
    expect(records[0].defenders.discovered).toBe(true);
    expect(records[0].defenders.nocover).toBe(false);
  }, 60_000);

  it('Jest cannot be asked: the verdict is unverifiable and says discovery was indeterminate, never NOCOVER', async () => {
    const root = gitProject({ mode: 'exit1' });
    const { records } = await run(root);
    expect(records[0].verdict).toBe('unverifiable');
    expect(records[0].detail.reason).toBe('defender-discovery-indeterminate');
    expect(records[0].detail.message).toMatch(/runner-native discovery \(jest --findRelatedTests\) gave no answer/);
    expect(records[0].defenders.nocover).toBe(false);
  }, 60_000);
});
