// Issue #268: a bare specifier that resolves to a workspace package inside the
// repository is code the defender runs, so it is in the import closure that
// `probe --changed` selects by and that verdict reuse hashes. Leaving it out
// was an UNDER-selection: a change to the package did not select the claims
// that run it, and their old verdicts stood for code that had changed.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportResolver } from '../src/probe/imports.mjs';
import { createDependencyHasher, sameDependencies } from '../src/probe/dependencies.mjs';
import { resolveProbeScope } from '../src/probe/scope.mjs';
import { commit, workspaceProject } from './helpers/workspace-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const ws = (options) => { const p = workspaceProject(options); roots.push(p.root); return p; };
const closure = (root, files) => createImportResolver(root).closure(files.map((file) => join(root, file)));
const PLANNER_TEST = 'packages/planner/test/estimate.test.js';

describe('a workspace package reached by its name is in the closure', () => {
  it.each(['npm', 'pnpm', 'link-only'])('follows the %s layout into the package source', (layout) => {
    const { root } = ws({ layout });
    const result = closure(root, [PLANNER_TEST]);
    expect(result.status).toBe('complete');
    expect(result.files).toEqual(expect.arrayContaining([
      'packages/geometry/package.json',
      'packages/geometry/src/index.js',
      'packages/geometry/src/shapes.js',
      'packages/geometry/src/units.js',
    ]));
  });

  it('follows a subpath and the package main field when there are no exports', () => {
    const { root } = ws({
      files: {
        'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', type: 'module', main: 'src/index.js' }),
        'packages/planner/src/estimate.js': "import { area } from '@ws/geometry';\nimport { toMm } from '@ws/geometry/src/units.js';\nexport const estimate = (w, h, r) => area(w, h) * r + toMm(0);\n",
      },
    });
    const result = closure(root, ['packages/planner/src/estimate.js']);
    expect(result.status).toBe('complete');
    expect(result.files).toEqual(expect.arrayContaining(['packages/geometry/src/index.js', 'packages/geometry/src/units.js', 'packages/geometry/package.json']));
  });

  it('includes every condition of an exports map, and a subpath pattern', () => {
    const { root } = ws({
      files: {
        'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', type: 'module', exports: { '.': { import: './src/index.js', require: './src/index.cjs', types: './missing.d.ts' }, './units/*': './src/*.js' } }),
        'packages/geometry/src/index.cjs': "module.exports = require('./legacy.cjs');\n",
        'packages/geometry/src/legacy.cjs': 'module.exports = {};\n',
        'packages/planner/src/estimate.js': "import { area } from '@ws/geometry';\nimport { toMm } from '@ws/geometry/units/units';\nexport const estimate = (w, h, r) => area(w, h) * r + toMm(0);\n",
      },
    });
    const result = closure(root, ['packages/planner/src/estimate.js']);
    expect(result.status).toBe('complete');
    expect(result.files).toEqual(expect.arrayContaining(['packages/geometry/src/index.js', 'packages/geometry/src/legacy.cjs', 'packages/geometry/src/units.js']));
  });

  it('cannot read an exports entry it cannot resolve: indeterminate, never smaller', () => {
    const { root } = ws({ files: { 'packages/geometry/package.json': JSON.stringify({ name: '@ws/geometry', type: 'module', exports: { '.': './dist/index.js' } }) } });
    const result = closure(root, [PLANNER_TEST]);
    expect(result.status).toBe('indeterminate');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unreadable-module', specifier: '@ws/geometry' })]));
  });

  it('leaves a link that resolves outside the repository outside the closure', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tg-ws-outside-')));
    roots.push(outside);
    mkdirSync(join(outside, 'src'), { recursive: true });
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: '@ext/thing', type: 'module', exports: './src/index.js' }));
    writeFileSync(join(outside, 'src/index.js'), 'export const thing = 1;\n');
    const { root } = ws({ files: { 'packages/planner/src/estimate.js': "import { area } from '@ws/geometry';\nimport { thing } from '@ext/thing';\nexport const estimate = (w, h, r) => area(w, h) * r * thing;\n" } });
    mkdirSync(join(root, 'node_modules/@ext'), { recursive: true });
    symlinkSync(outside, join(root, 'node_modules/@ext/thing'), 'dir');
    const result = closure(root, ['packages/planner/src/estimate.js']);
    expect(result.status).toBe('complete');
    expect(result.files.some((file) => file.includes('ext') || file.startsWith('..'))).toBe(false);
  });

  it('leaves an installed (not linked) package outside the closure', () => {
    const { root } = ws({ files: { 'packages/planner/src/estimate.js': "import { area } from '@ws/geometry';\nimport lodash from 'lodash';\nexport const estimate = (w, h, r) => area(w, h) * r;\n" } });
    mkdirSync(join(root, 'node_modules/lodash'), { recursive: true });
    writeFileSync(join(root, 'node_modules/lodash/package.json'), JSON.stringify({ name: 'lodash', main: 'index.js' }));
    writeFileSync(join(root, 'node_modules/lodash/index.js'), 'module.exports = {};\n');
    const result = closure(root, ['packages/planner/src/estimate.js']);
    expect(result.status).toBe('complete');
    expect(result.files.some((file) => file.includes('node_modules'))).toBe(false);
  });

  it('marks a workspace package outside the PROJECT (but inside the repository) indeterminate', () => {
    const { root } = ws();
    const planner = join(root, 'packages/planner');
    const result = createImportResolver(planner).closure([join(planner, 'test/estimate.test.js')]);
    expect(result.status).toBe('indeterminate');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unreadable-module', specifier: '@ws/geometry' })]));
  });
});

describe('verdict reuse sees a change inside a workspace package', () => {
  it('hashes the package source, so a comment-only edit refuses reuse', () => {
    const { root } = ws();
    const before = createDependencyHasher(root, { cache: false }).inputsFor(['packages/geometry/src/shapes.js', PLANNER_TEST]);
    expect(before.dependencyClosure).toBe('complete');
    expect(Object.keys(before.dependencyHashes)).toContain('packages/geometry/src/units.js');
    writeFileSync(join(root, 'packages/geometry/src/units.js'), `// a comment the baseline cannot see\n${readFileSync(join(root, 'packages/geometry/src/units.js'), 'utf8')}`);
    const after = createDependencyHasher(root, { cache: false }).inputsFor(['packages/geometry/src/shapes.js', PLANNER_TEST]);
    expect(sameDependencies(before, createDependencyHasher(root, { cache: false }).inputsFor(['packages/geometry/src/shapes.js', PLANNER_TEST]))).toBe(false);
    expect(sameDependencies(after, after)).toBe(true);
  });
});

describe('probe --changed never under-selects through a workspace link', () => {
  const claimsOf = (dir) => JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));

  it.each(['npm', 'pnpm'])('a change to a helper in the linked package selects the claim whose defender imports it (%s)', (layout) => {
    const p = ws({ layout });
    writeFileSync(join(p.root, 'packages/geometry/src/units.js'), `// comment only\n${readFileSync(join(p.root, 'packages/geometry/src/units.js'), 'utf8')}`);
    commit(p.root);
    const scope = resolveProbeScope({ projectDir: p.dir, claims: claimsOf(p.dir), ref: p.base });
    expect(scope.selected).toEqual(['ESTIMATE-USES-AREA', 'UNITS-CONVERT']);
  });

  it('a project that is one package selects its claims when a sibling package changes', () => {
    const p = ws({ claims: null });
    const planner = join(p.root, 'packages/planner');
    const claims = {
      schemaVersion: 1,
      claims: [{
        id: 'ESTIMATE', statement: 'Estimate holds.', source: { kind: 'spec', ref: 'README.md' }, severity: 'high',
        producedBy: { producer: 'agent', by: 'fixture' }, defendedBy: ['test/estimate.test.js'],
        faults: [{ id: 'F1', description: 'Break it.', faultClass: 'return-altered', file: 'src/estimate.js', find: '* rate', replace: '* 1', producedBy: { producer: 'agent', by: 'fixture' } }],
      }],
    };
    writeFileSync(join(p.root, 'packages/geometry/src/shapes.js'), 'export const area = (w, h) => w * h; // edited\n');
    commit(p.root);
    const scope = resolveProbeScope({ projectDir: planner, claims, ref: p.base });
    expect(scope.files).toEqual([]);
    expect(scope.selected).toEqual(['ESTIMATE']);
  });
});
