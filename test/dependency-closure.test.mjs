// Issue #232: the import closure that verdict reuse, status staleness and the
// origin-policy freshness check all hash. Over-inclusion costs a run; a file
// silently missing from it is a reused verdict nobody measured.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createImportResolver, parseModuleSource, tokenizeModule } from '../src/probe/imports.mjs';
import { pyClosure } from '../src/probe/pyimports.mjs';
import { createDependencyHasher, dependencyChanges, sameDependencies } from '../src/probe/dependencies.mjs';

const projects = [];
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'tg-closure-'));
  projects.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return root;
}
afterEach(() => { while (projects.length) rmSync(projects.pop(), { recursive: true, force: true }); });
const closure = (root, files, options) => createImportResolver(root, options).closure(files.map((file) => join(root, file)));

describe('the module lexer reads what real modules contain', () => {
  it('reads a regex literal containing a quote as one token, not an unterminated string', () => {
    const tokens = tokenizeModule("const re = /['\"]x/g;\nimport { a } from './a.mjs';\n");
    expect(tokens.filter((t) => t.type === 'regex')).toHaveLength(1);
    expect(parseModuleSource("const re = /['\"]x/g;\nimport { a } from './a.mjs';\n").runtime).toEqual(['./a.mjs']);
  });

  it('reads a slash after an operand as division, not a regex', () => {
    expect(parseModuleSource("const half = total / 2; const q = 'it' / 1;\nimport b from './b.mjs';\n").runtime).toEqual(['./b.mjs']);
    expect(tokenizeModule('x = 10 / 2 / 5;').some((t) => t.type === 'regex')).toBe(false);
    expect(tokenizeModule('f(a) / g(b) / h;').some((t) => t.type === 'regex')).toBe(false);
  });

  it('reads a regex after a keyword or an operator', () => {
    expect(tokenizeModule("function f(s) { return /'/.test(s); }").some((t) => t.type === 'regex')).toBe(true);
    expect(tokenizeModule("const ok = a && /'/.test(b);").some((t) => t.type === 'regex')).toBe(true);
  });

  it('reads a template whose expressions contain quotes, braces and nested templates', () => {
    const source = "const s = `a ${obj['k']} ${ { x: 1 }.x } ${`inner ${\"}\"}`} done`;\nimport c from './c.mjs';\n";
    expect(parseModuleSource(source).runtime).toEqual(['./c.mjs']);
  });
});

describe('JavaScript import closure', () => {
  it('follows every static, re-export, dynamic and require edge, transitively', () => {
    const root = project({
      'src/a.mjs': "import { b } from './b.mjs';\nexport * from './c.mjs';\nconst d = await import('./d.mjs');\nconst e = require('./e.cjs');\nimport './side.mjs';\n",
      'src/b.mjs': "export { deep } from './deep/leaf.mjs';\nexport const b = 1;\n",
      'src/c.mjs': 'export const c = 1;\n',
      'src/d.mjs': 'export default 1;\n',
      'src/e.cjs': "module.exports = require('./data.json');\n",
      'src/data.json': '{}\n',
      'src/side.mjs': '',
      'src/deep/leaf.mjs': "import fs from 'node:fs';\nimport lodash from 'lodash';\nexport const deep = 1;\n",
      'src/unrelated.mjs': 'export const x = 1;\n',
    });
    const result = closure(root, ['src/a.mjs']);
    expect(result).toEqual({ status: 'complete', files: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/data.json', 'src/deep/leaf.mjs', 'src/e.cjs', 'src/side.mjs'] });
  });

  it('a computed dynamic import or require is indeterminate, never silently smaller', () => {
    for (const source of ["const m = await import(name);\n", "const m = require('./x' + y);\n", 'const m = import(`./${name}.mjs`);\n']) {
      const root = project({ 'src/a.mjs': source });
      expect(closure(root, ['src/a.mjs'])).toMatchObject({ status: 'indeterminate', issues: [{ code: 'computed-specifier', file: 'src/a.mjs' }] });
    }
  });

  it('a method named import or require is not a module load', () => {
    const root = project({ 'src/a.mjs': 'export const loader = { load(x) { return this.import(x) || ctx.require(x); } };\nfunction require(x) { return x; }\n' });
    expect(closure(root, ['src/a.mjs']).status).toBe('complete');
  });

  it('a project-relative import that resolves to nothing is indeterminate', () => {
    const root = project({ 'src/a.mjs': "import { gone } from './gone.mjs';\n" });
    expect(closure(root, ['src/a.mjs'])).toMatchObject({ status: 'indeterminate', issues: [{ code: 'unreadable-module', file: 'src/a.mjs', specifier: './gone.mjs' }] });
  });

  it('an ambiguous resolution includes every candidate', () => {
    const root = project({ 'src/a.ts': "import { h } from './h';\n", 'src/h.ts': 'export const h = 1;\n', 'src/h/index.ts': 'export const h = 2;\n' });
    expect(closure(root, ['src/a.ts'])).toEqual({ status: 'complete', files: ['src/a.ts', 'src/h.ts', 'src/h/index.ts'] });
  });

  it('includes modules a test mocks or loads through the framework, and their manual mocks', () => {
    const root = project({
      'test/a.test.mjs': "vi.mock('../src/api.mjs');\nconst real = await vi.importActual('../src/real.mjs');\njest.mock('virtual-thing', () => ({}), { virtual: true });\nvi.mock('./not-there.mjs', () => ({}));\n",
      'src/api.mjs': 'export const api = 1;\n',
      'src/__mocks__/api.mjs': 'export const api = 2;\n',
      'src/real.mjs': 'export const real = 1;\n',
    });
    expect(closure(root, ['test/a.test.mjs'])).toEqual({ status: 'complete', files: ['src/__mocks__/api.mjs', 'src/api.mjs', 'src/real.mjs', 'test/a.test.mjs'] });
  });

  it('a module the lexer cannot read is indeterminate', () => {
    const root = project({ 'src/a.mjs': "import './b.mjs';\n", 'src/b.mjs': "const s = 'unterminated\n" });
    expect(closure(root, ['src/a.mjs'])).toMatchObject({ status: 'indeterminate', issues: [{ code: 'unsupported-syntax', file: 'src/b.mjs' }] });
  });

  it('a graph over the module limit is indeterminate', () => {
    const files = { 'src/a.mjs': "import './m0.mjs';\n" };
    for (let i = 0; i < 6; i++) files[`src/m${i}.mjs`] = `import './m${i + 1}.mjs';\n`;
    files['src/m6.mjs'] = '';
    const root = project(files);
    expect(closure(root, ['src/a.mjs'], { limits: { maxModules: 4 } })).toMatchObject({ status: 'indeterminate', issues: [{ code: 'graph-limit' }] });
    expect(closure(root, ['src/a.mjs']).status).toBe('complete');
  });
});

describe('Python import closure', () => {
  it('follows module names, the packages that run first, and every ancestor conftest.py', () => {
    const root = project({
      'conftest.py': '',
      'tests/conftest.py': 'from app.fixtures import make\n',
      'tests/unit/test_price.py': 'from app.price import total\n',
      'app/__init__.py': '',
      'app/fixtures.py': '',
      'app/price.py': 'from .helper import round_to\nimport json\n',
      'app/helper.py': 'import app.util as util\n',
      'app/util.py': '',
      'app/unrelated.py': '',
    });
    expect(pyClosure(root, ['tests/unit/test_price.py'])).toEqual({
      status: 'complete',
      files: ['app/__init__.py', 'app/fixtures.py', 'app/helper.py', 'app/price.py', 'app/util.py', 'conftest.py', 'tests/conftest.py', 'tests/unit/test_price.py'],
    });
  });

  it('a computed import_module or __import__ is indeterminate', () => {
    for (const source of ['import importlib\nm = importlib.import_module(name)\n', "m = __import__('app.' + x)\n"]) {
      const root = project({ 'app/__init__.py': '', 'app/a.py': source });
      expect(pyClosure(root, ['app/a.py'])).toMatchObject({ status: 'indeterminate', issues: [{ code: 'computed-specifier', file: 'app/a.py' }] });
    }
    const literal = project({ 'app/__init__.py': '', 'app/a.py': "import importlib\nm = importlib.import_module('app.b')\n", 'app/b.py': '' });
    expect(pyClosure(literal, ['app/a.py'])).toEqual({ status: 'complete', files: ['app/__init__.py', 'app/a.py', 'app/b.py'] });
  });

  it('a relative import that names no project module is indeterminate', () => {
    const root = project({ 'app/__init__.py': '', 'app/a.py': 'from .gone import x\n' });
    expect(pyClosure(root, ['app/a.py'])).toMatchObject({ status: 'indeterminate', issues: [{ code: 'unreadable-module', file: 'app/a.py', specifier: '.gone' }] });
  });
});

describe('dependency inputs and the shared predicate', () => {
  it('hashes the closure plus root manifests and lockfiles, and only those present', () => {
    const root = project({ 'package.json': '{}', 'package-lock.json': '{}', 'src/a.mjs': "import './b.mjs';\n", 'src/b.mjs': '', 'src/c.mjs': '' });
    const inputs = createDependencyHasher(root).inputsFor(['src/a.mjs']);
    expect(inputs.dependencyClosure).toBe('complete');
    expect(Object.keys(inputs.dependencyHashes)).toEqual(['package-lock.json', 'package.json', 'src/a.mjs', 'src/b.mjs']);
    expect(inputs).not.toHaveProperty('dependencyIssues');
  });

  it('a changed lockfile is a changed input', () => {
    const root = project({ 'package-lock.json': '{"v":1}', 'src/a.mjs': '' });
    const before = createDependencyHasher(root).inputsFor(['src/a.mjs']);
    writeFileSync(join(root, 'package-lock.json'), '{"v":2}');
    const after = createDependencyHasher(root).inputsFor(['src/a.mjs']);
    expect(sameDependencies(before, after)).toBe(false);
    expect(dependencyChanges(before, after, 'C/F1')).toEqual(['package-lock.json changed since C/F1 was probed']);
  });

  it('reports added, removed and legacy inputs as changes, but not indeterminacy alone', () => {
    const recorded = { dependencyHashes: { 'a.mjs': '1', 'b.mjs': '2' }, dependencyClosure: 'complete' };
    expect(dependencyChanges(recorded, { dependencyHashes: { 'a.mjs': '1', 'c.mjs': '3' }, dependencyClosure: 'complete' }, 'K')).toEqual(['b.mjs is no longer an input of K', 'c.mjs became an input of K since it was probed']);
    expect(dependencyChanges({}, recorded, 'K')).toEqual(['K predates dependency hashing and cannot be reused']);
    expect(dependencyChanges(recorded, { ...recorded, dependencyClosure: 'indeterminate' }, 'K')).toEqual([]);
    expect(sameDependencies(recorded, { ...recorded, dependencyClosure: 'indeterminate' })).toBe(false);
  });
});
