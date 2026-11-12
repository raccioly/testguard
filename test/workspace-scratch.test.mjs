// Issue #263: inside the scratch worktree a workspace link must resolve to the
// scratch tree's OWN copy of the package. Linked to the original checkout's
// copy, a defender in a sibling package ran unmodified code while the fault
// sat in the scratch tree, and every such fault was `subject-not-executed`.
// The proof is the one GATE-SEMANTICS rule 9 asks for: while the fault is
// applied, the file the defender loads is the faulted one (it goes red), and
// with the fault restored it goes green again.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createScratch, PreconditionError } from '../src/probe/worktree.mjs';
import { git, workspaceProject } from './helpers/workspace-project.mjs';

const roots = [];
const scratches = [];
afterEach(() => {
  while (scratches.length) scratches.pop().cleanup();
  while (roots.length) {
    const root = roots.pop();
    spawnSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
  }
});
const ws = (options) => { const p = workspaceProject(options); roots.push(p.root); return p; };
const scratch = (options) => { const s = createScratch(options); scratches.push(s); return s; };
const base = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-ws-scratch-'))); roots.push(dir); return dir; };

const inside = (root, path) => !relative(root, path).startsWith('..');
const runDefender = (dir) => spawnSync(process.execPath, ['--test', 'packages/planner/test/estimate.test.js'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
const FAULT = ['packages/geometry/src/shapes.js', 'export const area = (w, h) => w + h;\n'];

function expectFaultIsWhatRuns(tree) {
  expect(runDefender(tree.root).status).toBe(0);
  const original = readFileSync(join(tree.root, FAULT[0]), 'utf8');
  writeFileSync(join(tree.root, FAULT[0]), FAULT[1]);
  const faulted = runDefender(tree.root);
  expect(faulted.status, faulted.stdout).not.toBe(0);
  writeFileSync(join(tree.root, FAULT[0]), original);
  expect(runDefender(tree.root).status).toBe(0);
}

describe('a workspace link in the scratch tree resolves to the scratch tree', () => {
  it.each([
    ['npm', 'node_modules/@ws/geometry'],
    ['pnpm', 'packages/planner/node_modules/@ws/geometry'],
    ['link-only', 'node_modules/@ws/geometry'],
  ])('%s layout: %s points into the scratch tree, and the defender runs the fault', (layout, link) => {
    const p = ws({ layout });
    const tree = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase: base() });
    expect(realpathSync(join(tree.root, link))).toBe(realpathSync(join(tree.root, 'packages/geometry')));
    expectFaultIsWhatRuns(tree);
    // The user's tree is untouched: its link still names its own package.
    expect(realpathSync(join(p.root, link))).toBe(join(p.root, 'packages/geometry'));
  });

  it('holds when node_modules is borrowed from another checkout (a symlinked node_modules)', () => {
    const p = ws();
    // A second checkout of the same repository whose node_modules is the first one's.
    const other = join(base(), 'other');
    git(p.root, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
    symlinkSync(join(p.root, 'node_modules'), join(other, 'node_modules'), 'dir');
    const tree = scratch({ repoRoot: other, projectDir: other, scratchBase: base() });
    expect(realpathSync(join(tree.root, 'node_modules/@ws/geometry'))).toBe(realpathSync(join(tree.root, 'packages/geometry')));
    expectFaultIsWhatRuns(tree);
  });

  it('holds with a read-only shared install', () => {
    const p = ws();
    chmodSync(join(p.root, 'node_modules/@ws'), 0o555);
    chmodSync(join(p.root, 'node_modules'), 0o555);
    const tree = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase: base() });
    expect(realpathSync(join(tree.root, 'node_modules/@ws/geometry'))).toBe(realpathSync(join(tree.root, 'packages/geometry')));
    expectFaultIsWhatRuns(tree);
  });

  it('gives every tree its own layout (fault workers, the serial re-measure tree)', () => {
    const p = ws();
    const scratchBase = base();
    const a = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase });
    const b = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase });
    expect(inside(a.root, realpathSync(join(a.root, 'node_modules/@ws/geometry')))).toBe(true);
    expect(inside(b.root, realpathSync(join(b.root, 'node_modules/@ws/geometry')))).toBe(true);
    // A fault in one tree is invisible to the other.
    writeFileSync(join(a.root, FAULT[0]), FAULT[1]);
    expect(runDefender(a.root).status).not.toBe(0);
    expect(runDefender(b.root).status).toBe(0);
  });

  it('keeps an installed (not linked) package shared with the install', () => {
    const p = ws();
    mkdirSync(join(p.root, 'node_modules/lodash'), { recursive: true });
    writeFileSync(join(p.root, 'node_modules/lodash/package.json'), '{"name":"lodash"}');
    const tree = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase: base() });
    expect(realpathSync(join(tree.root, 'node_modules/lodash'))).toBe(join(p.root, 'node_modules/lodash'));
  });

  it('carries a workspace package\'s ignored build output, never its uncommitted source', () => {
    const p = ws({ files: { '.gitignore': 'node_modules/\ndist/\n' } });
    mkdirSync(join(p.root, 'packages/geometry/dist'), { recursive: true });
    writeFileSync(join(p.root, 'packages/geometry/dist/index.js'), 'export const built = 1;\n');
    writeFileSync(join(p.root, 'packages/geometry/src/uncommitted.js'), 'export const draft = 1;\n');
    const tree = scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase: base() });
    expect(readFileSync(join(tree.root, 'packages/geometry/dist/index.js'), 'utf8')).toContain('built');
    expect(existsSync(join(tree.root, 'packages/geometry/src/uncommitted.js'))).toBe(false);
  });

  it('refuses the run, naming the link, when the scratch tree cannot contain the linked package', () => {
    const p = ws({ files: { '.gitignore': 'node_modules/\nvendor/\n' } });
    mkdirSync(join(p.root, 'vendor/shim'), { recursive: true });
    writeFileSync(join(p.root, 'vendor/shim/package.json'), '{"name":"shim"}');
    symlinkSync('../vendor/shim', join(p.root, 'node_modules/shim'), 'dir');
    let error;
    try { scratch({ repoRoot: p.root, projectDir: p.dir, scratchBase: base() }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PreconditionError);
    expect(error.kind).toBe('workspace-link-outside-tree');
    expect(error.message).toContain('node_modules/shim');
  });
});
