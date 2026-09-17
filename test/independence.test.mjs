import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyIndependence } from '../src/probe/independence.mjs';
import { rank } from '../src/probe/rank.mjs';

/** A repository with a known authorship history: who wrote what, and when. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-indep-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  const g = (env, ...args) => {
    const r = spawnSync('git', ['-c', `user.email=${env}`, '-c', `user.name=${env}`, ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const write = (rel, body) => writeFileSync(join(dir, rel), body);
  g('agent@example.invalid', 'init', '-q');
  return { dir, g, write };
}

describe('classifyIndependence — maturity ladder L3, a signal and never a verdict', () => {
  it('code and its defender in ONE commit is co-authored', () => {
    const { dir, g, write } = repo();
    write('src/a.mjs', 'export const a = 1;\n');
    write('test/a.test.mjs', "import { a } from '../src/a.mjs';\n");
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'feature and its test');
    const r = classifyIndependence({ dir, targetFile: 'src/a.mjs', defenders: ['test/a.test.mjs'] });
    expect(r.class).toBe('co-authored');
    expect(r.defenderCommit).toBe(r.targetCommit);
    expect(r.sameAuthor).toBe(true);
  });

  it('a defender written later by a DIFFERENT author is a separate change', () => {
    const { dir, g, write } = repo();
    write('src/b.mjs', 'export const b = 1;\n');
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'feature');
    write('test/b.test.mjs', "import { b } from '../src/b.mjs';\n");
    g('human@example.invalid', 'add', '-A');
    g('human@example.invalid', 'commit', '-qm', 'test for it');
    const r = classifyIndependence({ dir, targetFile: 'src/b.mjs', defenders: ['test/b.test.mjs'] });
    expect(r.class).toBe('separate-change');
    expect(r.defenderCommit).not.toBe(r.targetCommit);
    expect(r.sameAuthor).toBe(false);
  });

  it('a later commit by the SAME author is still co-authored — a different commit is not independence', () => {
    const { dir, g, write } = repo();
    write('src/c.mjs', 'export const c = 1;\n');
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'feature');
    write('test/c.test.mjs', "import { c } from '../src/c.mjs';\n");
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'and its test, same agent');
    const r = classifyIndependence({ dir, targetFile: 'src/c.mjs', defenders: ['test/c.test.mjs'] });
    expect(r.class).toBe('co-authored');
    expect(r.sameAuthor).toBe(true);
  });

  it('one independently written defender is enough: the most independent decides', () => {
    const { dir, g, write } = repo();
    write('src/d.mjs', 'export const d = 1;\n');
    write('test/d1.test.mjs', "import { d } from '../src/d.mjs';\n");
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'feature and one test');
    write('test/d2.test.mjs', "import { d } from '../src/d.mjs';\n");
    g('human@example.invalid', 'add', '-A');
    g('human@example.invalid', 'commit', '-qm', 'an independent test');
    expect(classifyIndependence({ dir, targetFile: 'src/d.mjs', defenders: ['test/d1.test.mjs', 'test/d2.test.mjs'] }).class).toBe('separate-change');
  });

  it('no history, no defenders, or an untracked file is unknown — never guessed', () => {
    const { dir, g, write } = repo();
    write('src/e.mjs', 'export const e = 1;\n');
    g('agent@example.invalid', 'add', '-A');
    g('agent@example.invalid', 'commit', '-qm', 'feature');
    write('test/untracked.test.mjs', 'x');
    expect(classifyIndependence({ dir, targetFile: 'src/e.mjs', defenders: ['test/untracked.test.mjs'] }).class).toBe('unknown');
    expect(classifyIndependence({ dir, targetFile: 'src/e.mjs', defenders: [] }).class).toBe('unknown');
    expect(classifyIndependence({ dir, targetFile: 'src/nothing.mjs', defenders: ['test/x.test.mjs'] }).class).toBe('unknown');
    const empty = mkdtempSync(join(tmpdir(), 'tg-indep-nogit-'));
    expect(classifyIndependence({ dir: empty, targetFile: 'a.mjs', defenders: ['b.test.mjs'] }).class).toBe('unknown');
  });
});

describe('ranking reads the signal, additively', () => {
  it('a co-authored kill ranks below an independent one of equal severity, and the signal never changes a verdict', () => {
    const base = { severity: 'critical', sourceKind: 'spec', blast: 3 };
    const independent = rank({ ...base, independence: 'separate-change' }).score;
    const unknown = rank({ ...base, independence: 'unknown' }).score;
    const co = rank({ ...base, independence: 'co-authored' }).score;
    expect(independent).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(co);
    // absent signal must not move the score at all
    expect(rank(base).score).toBe(independent);
  });
});
