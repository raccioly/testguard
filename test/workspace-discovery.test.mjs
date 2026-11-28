// Issue #274: symbol-level defender discovery (rule 14) treated a bare
// specifier that names a workspace package as an external package, so a test
// that imports `@ws/geometry` was reported `nocover` for a claim on the
// package's own source. `relation()` now resolves a workspace package's entry
// the way the import closure does (#268) and follows the binding into it. An
// entry it cannot resolve is indeterminate, never `nocover`.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDefendersDetailed } from '../src/probe/discover.mjs';
import { createImportResolver } from '../src/probe/imports.mjs';
import { workspaceProject } from './helpers/workspace-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const ws = (options) => { const p = workspaceProject(options); roots.push(p.root); return p; };

const PLANNER_TEST = 'packages/planner/test/estimate.test.js';
const SHAPES = 'packages/geometry/src/shapes.js';
const testImporting = (names) => `import { test } from 'node:test';\nimport { ${names} } from '@ws/geometry';\ntest('uses it', () => { ${names.split(',')[0].trim()}; });\n`;

describe('discovery follows a workspace package binding into the package', () => {
  it.each(['npm', 'pnpm', 'link-only'])('finds a test that imports the package by name (%s layout)', (layout) => {
    const { root } = ws({ layout, files: { [PLANNER_TEST]: testImporting('area') } });
    const found = discoverDefendersDetailed(root, SHAPES);
    expect(found.importing).toContain(PLANNER_TEST);
    expect(found.indeterminate).toEqual([]);
  });

  it('records the package manifest and entry as discovery dependencies', () => {
    const { root } = ws({ files: { [PLANNER_TEST]: testImporting('area') } });
    const found = discoverDefendersDetailed(root, SHAPES);
    expect(found.dependencies).toEqual(expect.arrayContaining(['packages/geometry/package.json', 'packages/geometry/src/index.js']));
  });

  it('stays symbol-level: importing another binding of the package does not defend the file', () => {
    const { root } = ws({ files: { [PLANNER_TEST]: testImporting('toMm') } });
    const found = discoverDefendersDetailed(root, SHAPES);
    expect(found.importing).not.toContain(PLANNER_TEST);
    expect(found.indeterminate).toEqual([]);
  });

  it('follows a subpath import of the package', () => {
    const { root } = ws({
      files: {
        'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', type: 'module', main: 'src/index.js' }),
        [PLANNER_TEST]: "import { test } from 'node:test';\nimport { area } from '@ws/geometry/src/shapes.js';\ntest('uses it', () => { area; });\n",
      },
    });
    expect(discoverDefendersDetailed(root, SHAPES).importing).toContain(PLANNER_TEST);
  });

  it('is indeterminate, never nocover, when the package entry cannot be resolved', () => {
    const { root } = ws({
      files: {
        'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', type: 'module', exports: './src/missing.js' }),
        [PLANNER_TEST]: testImporting('area'),
      },
    });
    const found = discoverDefendersDetailed(root, SHAPES);
    expect(found.importing).toEqual([]);
    expect(found.indeterminate).toEqual([expect.objectContaining({ file: PLANNER_TEST, reason: 'unreadable-module' })]);
  });

  it('leaves an ordinary package outside discovery', () => {
    const { root } = ws({ files: { [PLANNER_TEST]: "import { test } from 'node:test';\nimport thing from 'left-pad';\ntest('x', () => { thing; });\n" } });
    const found = discoverDefendersDetailed(root, SHAPES);
    expect(found.importing).toEqual([]);
    expect(found.indeterminate).toEqual([]);
  });

  it('does not follow a package that lives outside the project directory', () => {
    const { root } = ws({ files: { [PLANNER_TEST]: testImporting('area') } });
    const relation = createImportResolver(join(root, 'packages/planner')).relation(join(root, PLANNER_TEST), 'src/estimate.js');
    expect(relation.status).toBe('not-matched');
  });
});
