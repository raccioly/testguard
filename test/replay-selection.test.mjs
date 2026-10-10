// @req FR-13
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { replay, findFixCommits, dedupeByPatch } from '../src/replay/replay.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

// Full native replay regressions remain in replay.test.mjs. These histories
// isolate selection and admission so their proof need not replay other bugs.
describe('replay selection and admission', () => {
  it('de-duplicates by patch-id: the same fix under two shas is one row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-dup-'));
    const g = (...args) => {
      const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    try {
    g('init', '-q');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'a.test.mjs'), "import { a } from './a.mjs';\n");
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'a.test.mjs'), "import { a } from './a.mjs';\n// asserted\n");
    g('add', '-A');
    g('commit', '-q', '-m', 'fix: two');
    const first = g('rev-parse', 'HEAD').trim();
    // the same patch again on a second branch: the dual-branch topology
    g('checkout', '-q', '-b', 'other', 'HEAD~1');
    // -x appends a provenance line to the message, so the SHA differs while
    // the patch is byte-identical. Without it git recreates the same commit
    // object exactly, and the test would pass whatever the code keys on.
    g('cherry-pick', '-x', first);
    expect(g('rev-parse', 'HEAD').trim()).not.toBe(first);
    const commits = findFixCommits({ dir, range: 'HEAD~1..HEAD' }).concat(findFixCommits({ dir, range: `${first}~1..${first}` }));
    expect(commits).toHaveLength(2);
    const { unique, duplicates } = dedupeByPatch({ dir, commits });
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('scopes to the project directory: a monorepo fix that also touches another package is replayed on this part of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-mono-'));
    const g = (...args) => {
      const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=r@example.invalid', '-c', 'user.name=r', ...args], { cwd: dir, encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    try {
    mkdirSync(join(dir, 'backend', 'src'), { recursive: true });
    mkdirSync(join(dir, 'backend', 'test'), { recursive: true });
    mkdirSync(join(dir, 'frontend', 'src'), { recursive: true });
    g('init', '-q');
    writeFileSync(join(dir, 'backend', 'src', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'backend', 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n");
    writeFileSync(join(dir, 'frontend', 'src', 'b.mjs'), 'export const b = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    // one fix, two packages — the shape a monorepo produces constantly
    writeFileSync(join(dir, 'backend', 'src', 'a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'backend', 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\n// asserted\n");
    writeFileSync(join(dir, 'frontend', 'src', 'b.mjs'), 'export const b = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'fix: both packages');

    const scoped = findFixCommits({ dir, range: 'HEAD~1..HEAD', projectDir: join(dir, 'backend') });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].source).toEqual(['backend/src/a.mjs']);   // the frontend file is not this project's to revert
    expect(scoped[0].tests).toEqual(['backend/test/a.test.mjs']);

    // unscoped, the same commit drags in a file that does not exist under the
    // project, which is what made every cross-package fix unverifiable
    expect(findFixCommits({ dir, range: 'HEAD~1..HEAD' })[0].source).toContain('frontend/src/b.mjs');

    // a commit with no source-and-test pair inside the project is not a candidate
    expect(findFixCommits({ dir, range: 'HEAD~1..HEAD', projectDir: join(dir, 'frontend') })).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });


  it('does not calibrate entirely new source as a bug with a prior version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-replay-new-source-'));
    const g = (...args) => execFileSync('git', [...FIXTURE_GIT, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: dir, timeout: 5000, encoding: 'utf8' });
    try {
      mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
      // A controlled command is enough here: the admission must refuse this
      // history before any execution. The native runner path is tested separately.
      writeFileSync(join(dir, 'runner.cjs'), 'process.exit(0);\n');
      g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
      writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
      writeFileSync(join(dir, 'test/value.test.mjs'), "import { value } from '../src/value.mjs';\n");
      g('add', '-A'); g('commit', '-qm', 'feat: entirely new source');
      const doc = await replay({ projectDir: dir, range: 'HEAD~1..HEAD', confirmRuns: 1, budgetMs: 3000,
        runnerCommand: `${JSON.stringify(process.execPath)} runner.cjs {files} {out}`, toolVersion: 'test' });
      expect(doc.records).toHaveLength(1);
      expect(doc.records[0]).toMatchObject({ verdict: 'unverifiable', reason: 'no-prior-version' });
      expect(validate('replay', doc).errors).toEqual([]);
      expect(g('status', '--porcelain')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
