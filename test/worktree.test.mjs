import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createScratch, PreconditionError } from '../src/probe/worktree.mjs';

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

  it('refuses a ref that does not resolve', () => {
    const { dir } = repo();
    expect(() => createScratch({ repoRoot: dir, projectDir: dir, ref: 'no-such-ref' })).toThrow(PreconditionError);
  });
});
