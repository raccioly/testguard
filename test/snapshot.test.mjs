import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotWorkingTree, headSha, git } from '../src/git.mjs';

describe('snapshotWorkingTree', () => {
  it('captures tracked edits AND untracked files in a dangling commit, leaving HEAD, index and status untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-snap-'));
    const g = (...a) => {
      const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    g('init', '-q');
    writeFileSync(join(dir, 'tracked.txt'), 'v1\n');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    const head = headSha(dir);
    writeFileSync(join(dir, 'tracked.txt'), 'v2\n');
    writeFileSync(join(dir, 'new.test.mjs'), 'export const n = 1;\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x\n');
    const statusBefore = g('status', '--porcelain');

    const snap = snapshotWorkingTree(dir);

    expect(snap).toMatch(/^[a-f0-9]{40}$/);
    expect(snap).not.toBe(head);
    expect(headSha(dir)).toBe(head);
    expect(g('status', '--porcelain')).toBe(statusBefore);
    expect(git(['show', `${snap}:tracked.txt`], dir)).toBe('v2');
    expect(git(['show', `${snap}:new.test.mjs`], dir)).toContain('n = 1');
    expect(() => git(['show', `${snap}:ignored.txt`], dir)).toThrow();
    expect(git(['rev-parse', `${snap}^`], dir)).toBe(head);
  });
});
