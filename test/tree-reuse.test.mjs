// #293 part 4: the baseline phase's scratch trees serve the fault phase, but
// only while git sees each exactly as it was created.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fillSlots, treeState } from '../src/probe/tree-reuse.mjs';

const tree = (worker, state) => ({ worker, stateAtCreation: 'clean', iso: { root: `/t${worker}` }, now: state });
const run = (kept, count) => {
  const released = [];
  const created = [];
  const r = fillSlots({ kept, count, release: (t) => released.push(t.worker), fresh: (i) => { created.push(i); return { worker: i, fresh: true }; }, stateOf: (t) => t.now });
  return { ...r, released, created };
};

describe('fillSlots', () => {
  it('reuses every unchanged kept tree for the worker index it had', () => {
    const r = run([tree(1, 'clean'), tree(2, 'clean'), tree(3, 'clean')], 4);
    expect(r.slots.map((s) => [s.worker, Boolean(s.fresh)])).toEqual([[1, false], [2, false], [3, false]]);
    expect(r).toMatchObject({ reused: 3, released: [], created: [] });
  });

  it('replaces a tree git no longer sees as created, and one that cannot be read', () => {
    const unreadable = { ...tree(2, 'x'), iso: { root: '/gone' } };
    const r = fillSlots({ kept: [tree(1, ' M src/a.mjs\0'), unreadable], count: 3, release: () => {}, fresh: (i) => ({ worker: i, fresh: true }), stateOf: (t) => { if (t === unreadable) throw new Error('no tree'); return t.now; } });
    expect(r.slots.map((s) => Boolean(s.fresh))).toEqual([true, true]);
    expect(r.reused).toBe(0);
    const released = run([tree(1, '?? left-over.txt\0')], 2);
    expect(released).toMatchObject({ released: [1], created: [1], reused: 0 });
  });

  it('creates what is missing and releases what the fault phase does not need', () => {
    expect(run([tree(1, 'clean')], 3)).toMatchObject({ reused: 1, created: [2], released: [] });
    expect(run([tree(1, 'clean'), tree(2, 'clean'), tree(3, 'clean')], 2)).toMatchObject({ reused: 1, created: [], released: [2, 3] });
  });
});

describe('treeState', () => {
  it('changes when a tracked file is edited or a file is left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-tree-state-'));
    try {
      const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir });
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'a');
      const created = treeState(dir);
      expect(treeState(dir)).toBe(created);
      writeFileSync(join(dir, 'b.txt'), 'b\n');
      expect(treeState(dir)).not.toBe(created);
      rmSync(join(dir, 'b.txt'));
      writeFileSync(join(dir, 'a.txt'), 'changed\n');
      expect(treeState(dir)).not.toBe(created);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
