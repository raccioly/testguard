// A throwaway two-package workspace (#263, #268): `packages/geometry` and
// `packages/planner`, where the planner's test reaches geometry ONLY by its
// package name, through a workspace link in node_modules. Layouts: npm/yarn
// (`node_modules/@ws/geometry -> ../../packages/geometry`, declared by
// package.json `workspaces`), pnpm (`packages/planner/node_modules/@ws/
// geometry -> ../../../geometry`, declared by pnpm-workspace.yaml) and a link
// nothing declares. Plain JavaScript under node:test: no install needed.
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { commit, git } from './scope-project.mjs';

export { commit, git };

const provenance = { producer: 'agent', by: 'fixture' };

const claim = (id, file, defender, faults) => ({
  id,
  statement: `${id} holds.`,
  source: { kind: 'spec', ref: 'README.md' },
  severity: 'high',
  producedBy: provenance,
  defendedBy: [defender],
  faults: faults.map(([fid, find, replace]) => ({ id: fid, description: 'Break it.', faultClass: 'return-altered', file, find, replace, producedBy: provenance })),
});

export function claimsDoc(prefix = '') {
  return {
    schemaVersion: 1,
    claims: [
      // Target in geometry, defender in planner: reached only through the link.
      claim('ESTIMATE-USES-AREA', `${prefix}packages/geometry/src/shapes.js`, `${prefix}packages/planner/test/estimate.test.js`, [['F1', 'w * h', 'w + h']]),
      claim('UNITS-CONVERT', `${prefix}packages/geometry/src/units.js`, `${prefix}packages/geometry/test/units.test.js`, [['F1', 'n * 10', 'n * 100']]),
    ],
  };
}

const unitsTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { toMm } from '../src/units.js';\n\ntest('cm to mm', () => {\n  assert.equal(toMm(2), 20);\n});\n";
const estimateTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { estimate } from '../src/estimate.js';\n\ntest('estimate is area times rate', () => {\n  assert.equal(estimate(3, 4, 2), 24);\n});\n";

export const FILES = {
  'README.md': '# workspace fixture\n',
  'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', version: '1.0.0', type: 'module', exports: './src/index.js' }),
  'packages/geometry/src/index.js': "export { area } from './shapes.js';\nexport { toMm } from './units.js';\n",
  'packages/geometry/src/shapes.js': 'export const area = (w, h) => w * h;\n',
  'packages/geometry/src/units.js': 'export const toMm = (n) => n * 10;\n',
  'packages/geometry/test/units.test.js': unitsTest,
  'packages/planner/package.json': JSON.stringify({ name: '@ws/planner', version: '1.0.0', type: 'module', exports: './src/estimate.js', dependencies: { '@ws/geometry': '1.0.0' } }),
  'packages/planner/src/estimate.js': "import { area } from '@ws/geometry';\nexport const estimate = (w, h, rate) => area(w, h) * rate;\n",
  'packages/planner/test/estimate.test.js': estimateTest,
};

/**
 * `layout`: 'npm' (root links, package.json `workspaces`), 'pnpm' (per-package
 * links, pnpm-workspace.yaml) or 'link-only' (root links, nothing declared).
 * `files` overrides or adds files (null removes one). `root` is the repository
 * and the project.
 */
export function workspaceProject({ layout = 'npm', files = {}, claims = claimsDoc() } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-ws-')));
  const rootPkg = { name: 'ws-root', private: true, type: 'module', ...(layout === 'npm' ? { workspaces: ['packages/*'] } : {}) };
  const all = {
    'package.json': JSON.stringify(rootPkg),
    '.gitignore': 'node_modules/\n',
    ...(layout === 'pnpm' ? { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" } : {}),
    ...FILES,
    ...(claims ? { 'testguard.claims.json': JSON.stringify(claims, null, 2) } : {}),
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const link = (at, target) => { mkdirSync(dirname(join(root, at)), { recursive: true }); symlinkSync(target, join(root, at), 'dir'); };
  if (layout === 'pnpm') link('packages/planner/node_modules/@ws/geometry', '../../../geometry');
  else {
    link('node_modules/@ws/geometry', '../../packages/geometry');
    link('node_modules/@ws/planner', '../../packages/planner');
  }
  git(root, 'init', '-q', '-b', 'main');
  const base = commit(root, 'base');
  return { root, dir: root, base };
}
