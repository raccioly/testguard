import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInventory, inventoryChanged, matchGlobs, walk, walkCount } from '../src/util/glob.mjs';
import { resolveDefenders, listTestFiles } from '../src/probe/runners/shared.mjs';
import { discoverDefenders } from '../src/probe/discover.mjs';
import { computeChangedGate } from '../src/gate/changed.mjs';
import { repo } from './helpers/gate-project.mjs';

const put = (root, rel, text = '') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

describe('one inventory serves every defender resolution (#231)', () => {
  let dir;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-inv-')));
    for (const f of ['src/a.mjs', 'src/b.mjs', 'test/a.test.mjs', 'test/deep/b.test.mjs', 'test/z.spec.mjs', 'README.md',
      'node_modules/pkg/x.test.mjs', 'dist/built.test.mjs', '.claude/worktrees/o/test/t.test.mjs']) put(dir, f);
    put(dir, 'outside/real.test.mjs');
    symlinkSync(join(dir, 'outside'), join(dir, 'test/linked-dir'));
    symlinkSync(join(dir, 'outside/real.test.mjs'), join(dir, 'test/linked-file.test.mjs'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const LISTS = [
    ['test/a.test.mjs'], ['test/missing.test.mjs'], ['test/*.test.mjs'], ['**/*.test.mjs'], ['test/**'], ['src/?.mjs', 'test/z.spec.mjs'],
    ['test/z.spec.mjs', 'test/a.test.mjs'], ['test/a.test.mjs', 'test/*.test.mjs'], ['node_modules/**'], ['**/*.test.mjs', '**/*.spec.mjs'], [],
  ];

  it('answers exactly as a fresh walk does: literals, globs, overrides, order and duplicates', () => {
    const inv = createInventory(dir);
    for (const list of LISTS) {
      expect(matchGlobs(dir, list, inv), JSON.stringify(list)).toEqual(matchGlobs(dir, list));
      expect(resolveDefenders(dir, list, inv), JSON.stringify(list)).toEqual(resolveDefenders(dir, list));
    }
    expect(listTestFiles(dir, undefined, inv)).toEqual(listTestFiles(dir));
    expect(inv.files).toEqual(walk(dir));
  });

  it('keeps the walker policy: skipped directories stay out, symbolic links are never followed', () => {
    const inv = createInventory(dir);
    expect(inv.files).not.toContain('test/linked-file.test.mjs');
    expect(inv.files.some((f) => f.startsWith('test/linked-dir/'))).toBe(false);
    expect(inv.files.some((f) => /node_modules|dist\/|\.claude/.test(f))).toBe(false);
    expect(matchGlobs(dir, ['**/*.test.mjs'], inv)).toEqual(['outside/real.test.mjs', 'test/a.test.mjs', 'test/deep/b.test.mjs']);
  });

  it('discovery over the snapshot finds the same defenders as discovery over a walk', () => {
    put(dir, 'src/a.mjs', 'export const a = 1;\n');
    put(dir, 'test/a.test.mjs', "import { a } from '../src/a.mjs';\nconsole.log(a);\n");
    const inv = createInventory(dir);
    expect(discoverDefenders(dir, 'src/a.mjs', undefined, inv)).toEqual(discoverDefenders(dir, 'src/a.mjs'));
    expect(discoverDefenders(dir, 'src/a.mjs', undefined, inv)).toContain('test/a.test.mjs');
  });

  it('is frozen, is bound to its root, and refuses to answer for another', () => {
    const inv = createInventory(dir);
    expect(Object.isFrozen(inv) && Object.isFrozen(inv.files)).toBe(true);
    expect(() => matchGlobs(join(dir, 'src'), ['*.mjs'], inv)).toThrow(/cannot answer for/);
  });

  it('inventoryChanged sees a file that appears, one that goes, and nothing else', () => {
    const inv = createInventory(dir);
    expect(inventoryChanged(inv)).toBe(false);
    put(dir, 'test/new.test.mjs');
    expect(inventoryChanged(inv)).toBe(true);
    rmSync(join(dir, 'test/new.test.mjs'));
    expect(inventoryChanged(inv)).toBe(false);
    rmSync(join(dir, 'test/a.test.mjs'));
    expect(inventoryChanged(inv)).toBe(true);
  });

  it('inventoryChanged sees a rename that leaves the file count unchanged', () => {
    const inv = createInventory(dir);
    renameSync(join(dir, 'src/b.mjs'), join(dir, 'src/c.mjs'));
    expect(inventoryChanged(inv)).toBe(true);
  });
});

describe('the changed-file gate walks the repository once, not once per fault (#231)', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  it('many faults, declared and discovered, cost a fixed number of walks and the same coverage', () => {
    const path = join(r.project, 'testguard.claims.json');
    const claims = JSON.parse(readFileSync(path, 'utf8'));
    const base = claims.claims[0];
    put(r.project, 'test/deep/unreferenced.test.mjs', '// no claim names it\n');
    const extra = [];
    for (let i = 0; i < 40; i++) {
      put(r.project, `test/gen${i}.test.mjs`, '// generated\n');
      extra.push({
        ...structuredClone(base),
        id: `GEN-${i}`,
        defendedBy: i % 2 ? [`test/gen${i}.test.mjs`] : [],
        faults: base.faults.map((f) => ({ ...f, defendedBy: i % 3 === 0 ? [`test/gen${i}.test.mjs`, 'test/*.test.mjs'] : undefined })),
      });
    }
    claims.claims.push(...extra);
    writeFileSync(path, JSON.stringify(claims));
    const before = walkCount();
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true });
    const walks = walkCount() - before;
    // One walk for the snapshot, one to confirm the tree held still; not one per fault.
    expect(walks).toBe(2);
    // Same coverage as resolving every fault against its own fresh walk.
    const expected = new Set();
    for (const c of claims.claims) for (const f of c.faults) {
      const requested = f.defendedBy?.length ? f.defendedBy : c.defendedBy ?? [];
      for (const d of requested.length ? resolveDefenders(r.project, requested) : discoverDefenders(r.project, f.file)) expected.add(d);
    }
    const covered = new Set(doc.covered.filter((c) => c.by === 'defender').map((c) => c.file));
    for (let i = 0; i < 40; i++) expect(covered.has(`test/gen${i}.test.mjs`), `gen${i}`).toBe(expected.has(`test/gen${i}.test.mjs`));
    expect(covered.size).toBeGreaterThan(0);
    expect(doc.uncovered.map((u) => u.file)).toContain('test/deep/unreferenced.test.mjs');
  });
});



