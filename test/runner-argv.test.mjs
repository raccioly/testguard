// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// Each runner's `argvFor` is a pure function of the project directory and the
// files, exported — as its own comment says — "so it is falsifiable without
// spawning anything". Until now the claim that the command line starts with
// the binary resolved FOR THAT PROJECT was defended only by the vitest and
// jest fixture probes, at 33-37 s a run and 116 s of the gate, to falsify a
// value that can be read in a millisecond.
//
// This file asserts the argv itself. It never spawns a runner: whether the
// resolved binary then works is a different claim, defended by the fixture
// acceptance tests that already run on every `npm test`.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vitestRunner from '../src/probe/runners/vitest.mjs';
import * as jestRunner from '../src/probe/runners/jest.mjs';
import { runnerArgv } from '../src/probe/runners/shared.mjs';
import { selectRunner, RUNNER_NAMES } from '../src/probe/runners/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A project that really has the runner installed, so resolution has something to find. */
function projectWith(pkg) {
  const dir = mkdtempSync(join(tmpdir(), `tg-argv-${pkg}-`));
  const mod = join(dir, 'node_modules', pkg);
  mkdirSync(join(mod, 'bin'), { recursive: true });
  writeFileSync(join(mod, 'package.json'), JSON.stringify({ name: pkg, version: '9.9.9', bin: { [pkg]: `bin/${pkg}.js` } }));
  writeFileSync(join(mod, 'bin', `${pkg}.js`), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', devDependencies: { [pkg]: '9.9.9' } }));
  return dir;
}

describe('the command line starts with the binary resolved for THIS project', () => {
  for (const [pkg, runner] of [['vitest', vitestRunner], ['jest', jestRunner]]) {
    it(`${pkg}: argv leads with the project's own resolution, never the bare name`, () => {
      const dir = projectWith(pkg);
      const resolved = runnerArgv(dir, pkg, pkg);
      const argv = runner.argvFor(dir, ['test/a.test.mjs'], '/tmp/out.json');

      // The prefix IS the resolution. A hard-coded `['vitest', ...]` would run
      // whatever is on PATH — a different version from the one the project
      // pins, and a verdict about the wrong code.
      expect(argv.slice(0, resolved.length)).toEqual(resolved);
      expect(resolved[0]).not.toBe(pkg);
      expect(resolved.some((a) => a.includes(join('node_modules', pkg)))).toBe(true);
      expect(argv[0]).not.toBe(pkg);
    });

    it(`${pkg}: a project without it resolves to the bare binary, and still leads the argv`, () => {
      // No local install: resolution falls back to the name, which `checkRunner`
      // will later reject as a precondition failure. The argv must still be
      // built from whatever resolution returned, never from a literal.
      const bare = mkdtempSync(join(tmpdir(), 'tg-argv-bare-'));
      writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'p' }));
      const resolved = runnerArgv(bare, pkg, pkg);
      expect(resolved).toEqual([pkg]);
      expect(runner.argvFor(bare, [], '/tmp/out.json').slice(0, 1)).toEqual([pkg]);
    });
  }

  it('vitest: the files and the JSON reporter follow the resolution', () => {
    const dir = projectWith('vitest');
    const argv = vitestRunner.argvFor(dir, ['test/a.test.mjs', 'test/b.test.mjs'], '/tmp/out.json');
    expect(argv).toContain('run');
    expect(argv).toContain('test/a.test.mjs');
    expect(argv).toContain('--reporter=json');
    expect(argv).toContain('--outputFile=/tmp/out.json');
    expect(argv).not.toContain('--no-file-parallelism');
    expect(vitestRunner.argvFor(dir, [], '/tmp/o.json', { serial: true })).toContain('--no-file-parallelism');
  });

  it('jest: positionals are passed by path, because jest would read them as regexes', () => {
    const dir = projectWith('jest');
    const argv = jestRunner.argvFor(dir, ['test/a+b.test.mjs'], '/tmp/out.json');
    // A path containing `+` or `(` silently matches nothing without this flag,
    // and a run of zero tests is not a verdict about anything.
    expect(argv).toContain('--runTestsByPath');
    expect(argv.indexOf('--runTestsByPath')).toBeLessThan(argv.indexOf('test/a+b.test.mjs'));
    expect(argv).toContain('--ci');
    expect(argv).toContain('--outputFile=/tmp/out.json');
    expect(jestRunner.argvFor(dir, [], '/tmp/o.json', { serial: true })).toContain('--runInBand');
  });

  it("this repository's own vitest resolves out of its node_modules", () => {
    // The tool probing itself is the case that matters most: a bare `vitest`
    // here would silently be a different install from the pinned devDependency.
    const argv = vitestRunner.argvFor(ROOT, [], '/tmp/o.json');
    expect(argv[0]).not.toBe('vitest');
    expect(argv.some((a) => a.includes(join('node_modules', 'vitest')))).toBe(true);
  });
});

/**
 * Runner selection, without a fixture probe.
 *
 * `selectRunner` resolves; the expensive part of proving it is spawning the
 * runners it resolves to. The rules that do not need a spawn — an unknown name
 * is a usage error rather than a silent fallback, and `auto` tries the
 * documented order — are pure enough to assert here, which is what stops a
 * claim about a one-line guard from paying a 33-second jest fixture probe.
 */
describe('selectRunner', () => {
  it('an unknown name is a usage error, never a silent fallback to a runner that happens to resolve', async () => {
    // Silently falling back would run SOME runner and emit verdicts under it,
    // and the evidence would name a runner the operator never asked for.
    const r = await selectRunner({ projectDir: ROOT, name: 'bogus' });
    expect(r.error).toMatch(/unknown runner "bogus"/);
    expect(r.runner).toBeUndefined();
    for (const known of RUNNER_NAMES) expect(r.error).toContain(known);
  });

  it('auto tries vitest, then jest, then python — and names what it picked', async () => {
    const r = await selectRunner({ projectDir: ROOT, name: 'auto' });
    expect(r.error).toBeUndefined();
    expect(r.runner.name).toBe('vitest'); // this repository pins vitest, the first candidate
    expect(r.source).toBe('project');
  });

  it('an explicit known name is honoured rather than re-resolved through auto', async () => {
    const dir = projectWith('jest');
    const r = await selectRunner({ projectDir: dir, name: 'jest' });
    expect(r.error).toBeUndefined();
    expect(r.runner.name).toBe('jest');
  });
});
