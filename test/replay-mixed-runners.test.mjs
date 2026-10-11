import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReplayRunnerUniverse, partitionReplayDefenders, replay } from '../src/replay/replay.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hasPython = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' }).status === 0;
const temporary = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const manifest = (files) => Object.freeze({ files: Object.freeze(files) });

describe('replay runner ownership comes from frozen manifest membership', () => {
  const vitest = { name: 'vitest' };
  const playwright = { name: 'playwright' };
  const python = { name: 'python' };

  it('gives an owned runner precedence over primary overlap and accepts custom filenames', () => {
    const universe = buildReplayRunnerUniverse(vitest, new Map([
      [vitest, manifest(['test/unit.test.mjs', 'browser/checkout.spec.ts'])],
      // checkout.case.ts intentionally matches neither *.test.* nor *.spec.*.
      // Native Playwright membership, not a filename guess, owns it.
      [playwright, manifest(['browser/checkout.spec.ts', 'browser/checkout.case.ts'])],
    ]));

    expect(universe.files).toEqual(['browser/checkout.case.ts', 'browser/checkout.spec.ts', 'test/unit.test.mjs']);
    expect(universe.ownerOf('browser/checkout.spec.ts')).toBe(playwright);
    expect(universe.ownerOf('browser/checkout.case.ts')).toBe(playwright);
    const partition = Object.fromEntries([...partitionReplayDefenders(universe.files, vitest, universe)].map(([owner, files]) => [owner.name, files]));
    expect(partition).toEqual({
      vitest: ['test/unit.test.mjs'],
      playwright: ['browser/checkout.case.ts', 'browser/checkout.spec.ts'],
    });
  });

  it('keeps a Playwright-looking file on primary when only primary listed it', () => {
    const universe = buildReplayRunnerUniverse(vitest, new Map([
      [vitest, manifest(['browser/checkout.spec.ts'])],
      [playwright, manifest([])],
    ]));
    expect(universe.ownerOf('browser/checkout.spec.ts')).toBe(vitest);
  });

  it('fails closed when two owned runner manifests list the same file', () => {
    expect(() => buildReplayRunnerUniverse(vitest, new Map([
      [vitest, manifest([])],
      [playwright, manifest(['checks/shared.case'])],
      [python, manifest(['checks/shared.case'])],
    ]))).toThrow(/listed by both playwright and python/);
  });

  it('refuses a defender absent from the exact configured union', () => {
    const universe = buildReplayRunnerUniverse(vitest, new Map([[vitest, manifest(['test/unit.test.mjs'])]]));
    expect(() => partitionReplayDefenders(['test/not-collected.test.mjs'], vitest, universe)).toThrow(/not in any resolved runner/);
  });
});

function mixedCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replay-mixed-'));
  temporary.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '5.0.1' } }));
  writeFileSync(join(dir, 'src', 'value.mjs'), 'export const value = () => 0;\n');
  writeFileSync(join(dir, 'pkg', '__init__.py'), '');
  writeFileSync(join(dir, 'pkg', 'value.py'), 'def value():\n    return 0\n');
  writeFileSync(join(dir, 'test', 'existing.test.mjs'), `import { expect, it } from 'vitest';
import { value } from '../src/value.mjs';
it('accepts the broad historical range', () => expect(value()).toBeGreaterThanOrEqual(0));
`);
  writeFileSync(join(dir, 'tests', 'test_value.py'), `import unittest
from pkg.value import value

class ExistingDetector(unittest.TestCase):
    def test_value_is_correct(self):
        self.assertEqual(value(), 1)
`);
  const git = (...args) => {
    const result = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=replay@example.invalid', '-c', 'user.name=Replay', ...args], { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'ship the mixed-language bug');

  writeFileSync(join(dir, 'src', 'value.mjs'), 'export const value = () => 1;\n');
  writeFileSync(join(dir, 'pkg', 'value.py'), 'def value():\n    return 1\n');
  writeFileSync(join(dir, 'test', 'fix.test.mjs'), `import { expect, it } from 'vitest';
import { value } from '../src/value.mjs';
it('pins the corrected value', () => expect(value()).toBe(1));
`);
  git('add', '-A');
  git('commit', '-qm', 'fix: correct both implementations');
  return dir;
}

describe.skipIf(!hasPython)('replay executes every configured runner in a mixed project', () => {
  it('merges a passing primary run and a failing owned run pessimistically', async () => {
    const dir = mixedCorpus();
    const document = await replay({ projectDir: dir, range: 'HEAD~1..HEAD', confirmRuns: 1, budgetMs: 60_000, toolVersion: 'test' });
    expect(document.records).toHaveLength(1);
    expect(document.records[0]).toMatchObject({ verdict: 'caught', ranTests: 2 });
    expect(document.records[0].runs).toHaveLength(1);
    expect(document.records[0].runs[0]).toMatchObject({ outcome: 'fail', assertionFailures: 1 });
  }, 180_000);
});
