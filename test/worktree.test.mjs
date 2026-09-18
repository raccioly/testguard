// @req FR-02
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratch, findNodeModules, PreconditionError } from '../src/probe/worktree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-wt-'));
  const g = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'first\n');
  g('add', 'a.txt');
  g('commit', '-qm', 'one');
  const first = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'second\n');
  g('commit', '-qam', 'two');
  return { dir, first };
}

describe('createScratch', () => {
  it('checks out HEAD by default, links node_modules, and cleans up', () => {
    const { dir } = repo();
    const s = createScratch({ repoRoot: dir, projectDir: dir });
    expect(readFileSync(join(s.projectDir, 'a.txt'), 'utf8')).toBe('second\n');
    expect(existsSync(join(s.root, 'node_modules', 'dep'))).toBe(true);
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  });

  it('checks out a pinned ref and reports its sha', () => {
    const { dir, first } = repo();
    const s = createScratch({ repoRoot: dir, projectDir: dir, ref: first.slice(0, 8) });
    expect(readFileSync(join(s.projectDir, 'a.txt'), 'utf8')).toBe('first\n');
    expect(s.sha).toBe(first);
    s.cleanup();
  });

  it('treats a SYMLINKED node_modules as one (the sibling/auto-worktree layout) and links its target', () => {
    const { dir } = repo();
    const real = mkdtempSync(join(tmpdir(), 'tg-real-nm-'));
    mkdirSync(join(real, 'dep'));
    writeFileSync(join(real, 'dep', 'marker'), 'x');
    const linked = mkdtempSync(join(tmpdir(), 'tg-linked-'));
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'init', '-q'], { cwd: linked });
    writeFileSync(join(linked, 'a.txt'), 'a\n');
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', 'a.txt'], { cwd: linked });
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'one'], { cwd: linked });
    symlinkSync(real, join(linked, 'node_modules'), 'dir');
    expect(findNodeModules(linked).map((n) => n.rel)).toEqual(['node_modules']);
    const s = createScratch({ repoRoot: linked, projectDir: linked });
    expect(existsSync(join(s.root, 'node_modules', 'dep', 'marker'))).toBe(true);
    s.cleanup();
    void dir;
  });

  it('links an explicit --node-modules path into the probed project', () => {
    const { dir } = repo();
    const nm = mkdtempSync(join(tmpdir(), 'tg-explicit-nm-'));
    mkdirSync(join(nm, 'explicit'));
    const s = createScratch({ repoRoot: dir, projectDir: dir, nodeModules: nm });
    expect(existsSync(join(s.root, 'node_modules', 'explicit'))).toBe(true);
    s.cleanup();
  });

  it('refuses a ref that does not resolve', () => {
    const { dir } = repo();
    expect(() => createScratch({ repoRoot: dir, projectDir: dir, ref: 'no-such-ref' })).toThrow(PreconditionError);
  });
});

/**
 * The isolation a probe actually created, asserted through a real run.
 *
 * `createScratch` is unit-tested above, but nothing cheap checked that `probe`
 * CHOOSES it: forcing the isolation to in-place left every fast test green,
 * because they all probe in place anyway. The only assertion that noticed was
 * in the 37-second known-answer fixture, so the claim about never touching the
 * user's tree was paying an end-to-end oracle to falsify a one-line ternary.
 *
 * `run.mode` is recorded from the isolation object rather than from the `mode`
 * argument, so it is a fact about the run and not an echo of its input.
 */
describe('probe chooses its isolation, and says which one it used', () => {
  it('worktree mode probes a scratch copy and leaves the project tree untouched', async () => {
    const { probe } = await import('../src/probe/probe.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tg-iso-'));
    const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
    writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { expect, it } from 'vitest';\nimport { a } from '../src/a.mjs';\nit('is one', () => expect(a()).toBe(1));\n");
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const before = readFileSync(join(dir, 'src', 'a.mjs'), 'utf8');
    const claims = {
      schemaVersion: 1,
      claims: [{
        id: 'C-1', statement: 'a() returns one.', severity: 'low', source: { kind: 'manual' },
        producedBy: { producer: 'human' }, defendedBy: ['test/a.test.mjs'],
        faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } }],
      }],
    };
    const ev = await probe({ projectDir: dir, claims, mode: 'worktree', confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't' });
    // A record saying `worktree` while the probe edited the project in place
    // would be a false statement about where the evidence came from, and
    // nothing downstream could detect it.
    expect(ev.run.mode).toBe('worktree');
    expect(ev.records[0].verdict).toBe('killed');
    expect(readFileSync(join(dir, 'src', 'a.mjs'), 'utf8')).toBe(before);
  }, 120_000);
});
