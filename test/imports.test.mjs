import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createImportResolver, IMPORT_LIMITS } from '../src/probe/imports.mjs';

const projects = [];

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'tg-imports-'));
  projects.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return root;
}

function relation(root, importer, target, options) {
  return createImportResolver(root, options).relation(join(root, importer), target);
}

afterEach(() => {
  while (projects.length) rmSync(projects.pop(), { recursive: true, force: true });
});

describe('symbol-aware JavaScript and TypeScript import resolution', () => {
  it('does not confuse import.meta with an import declaration', () => {
    const root = project({
      'src/leaf.ts': 'export const thing = 1;\n',
      'test/meta.test.ts': "import { thing } from '../src/leaf';\nconst here = new URL('.', import.meta.url);\nexpect(thing).toBe(1);\n",
    });
    expect(relation(root, 'test/meta.test.ts', 'src/leaf.ts').status).toBe('matched');
  });

  it('resolves an exported async function as a concrete symbol', () => {
    const root = project({
      'src/leaf.ts': 'export async function load() { return 1; }\n',
      'test/load.test.ts': "import { load } from '../src/leaf';\nexpect(load).toBeDefined();\n",
    });
    expect(relation(root, 'test/load.test.ts', 'src/leaf.ts').status).toBe('matched');
  });

  it('follows renamed named exports and reports deterministic witnesses and dependencies', () => {
    const root = project({
      'src/leaf.ts': 'export const thing = 1; export const other = 2;\n',
      'src/barrel.ts': "export { thing as publicThing } from './leaf';\n",
      'src/index.ts': "export { publicThing as api } from './barrel';\n",
      'test/api.test.ts': "import { api as subject } from '../src/index'; expect(subject).toBe(1);\n",
    });

    expect(relation(root, 'test/api.test.ts', 'src/leaf.ts')).toEqual({
      status: 'matched',
      bindings: ['subject'],
      paths: [['test/api.test.ts', 'src/index.ts', 'src/barrel.ts', 'src/leaf.ts']],
      dependencies: ['src/barrel.ts', 'src/index.ts'],
    });
    expect(relation(root, 'test/api.test.ts', 'src/missing.ts')).toMatchObject({
      status: 'indeterminate', reason: 'unreadable-module',
    });
  });

  it('keeps default exports out of export-star while following an explicit default re-export', () => {
    const root = project({
      'src/leaf.ts': 'export default function leaf() {}\nexport const named = 1;\n',
      'src/star.ts': "export * from './leaf';\n",
      'src/default.ts': "export { default } from './leaf';\n",
      'test/star.test.ts': "import value from '../src/star'; void value;\n",
      'test/default.test.ts': "import value from '../src/default'; void value;\n",
    });

    expect(relation(root, 'test/star.test.ts', 'src/leaf.ts').status).toBe('not-matched');
    expect(relation(root, 'test/default.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'matched', bindings: ['value'],
    });
  });

  it('fails closed for ambiguous star exports and lets an explicit export shadow them', () => {
    const root = project({
      'src/a.ts': 'export const same = 1;\n',
      'src/b.ts': 'export const same = 2;\n',
      'src/ambiguous.ts': "export * from './a'\nexport * from './b'\n",
      'src/explicit.ts': "export * from './a'; export * from './b'; export { same } from './a';\n",
      'test/ambiguous.test.ts': "import { same } from '../src/ambiguous'; void same;\n",
      'test/explicit.test.ts': "import { same } from '../src/explicit'; void same;\n",
    });

    expect(relation(root, 'test/ambiguous.test.ts', 'src/a.ts')).toMatchObject({
      status: 'indeterminate', reason: 'ambiguous-resolution',
    });
    expect(relation(root, 'test/explicit.test.ts', 'src/a.ts').status).toBe('matched');
    expect(relation(root, 'test/explicit.test.ts', 'src/b.ts').status).toBe('not-matched');
  });

  it('terminates cycles, preserving a concrete origin and rejecting an originless cycle', () => {
    const root = project({
      'src/leaf.ts': 'export const found = 1;\n',
      'src/a.ts': "export * from './b';\n",
      'src/b.ts': "export { found } from './leaf'; export * from './a';\n",
      'src/c.ts': "export * from './d';\n",
      'src/d.ts': "export * from './c';\n",
      'test/found.test.ts': "import { found } from '../src/a'; void found;\n",
      'test/lost.test.ts': "import { lost } from '../src/c'; void lost;\n",
    });

    expect(relation(root, 'test/found.test.ts', 'src/leaf.ts').status).toBe('matched');
    expect(relation(root, 'test/lost.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'indeterminate', reason: 'cyclic-export-without-origin',
    });
  });

  it('resolves injected aliases and reports the alias configuration as a dependency', () => {
    const root = project({
      'tsconfig.json': '{}\n',
      'src/leaf.ts': 'export const value = 1;\n',
      'src/barrel.ts': "export { value } from '@/leaf';\n",
      'test/value.test.ts': "import { value } from '../src/barrel'; void value;\n",
    });
    const aliases = [{ prefix: '@/', suffix: '', wildcard: true, targets: [join(root, 'src', '*')] }];

    expect(relation(root, 'test/value.test.ts', 'src/leaf.ts', {
      aliases,
      configFiles: ['tsconfig.json'],
    })).toMatchObject({
      status: 'matched',
      dependencies: ['src/barrel.ts', 'tsconfig.json'],
    });
  });

  it('ignores type-only imports and type-only re-exports', () => {
    const root = project({
      'src/leaf.ts': 'export type Shape = { value: number };\n',
      'src/barrel.ts': "export type { Shape } from './leaf';\n",
      'test/direct.test.ts': "import type { Shape } from '../src/leaf'; const value = /** @type {Shape} */ ({});\n",
      'test/barrel.test.ts': "import { Shape } from '../src/barrel'; void Shape;\n",
    });

    expect(relation(root, 'test/direct.test.ts', 'src/leaf.ts').status).toBe('not-matched');
    expect(relation(root, 'test/barrel.test.ts', 'src/leaf.ts').status).toBe('not-matched');
  });

  it('resolves static namespace properties but fails closed for opaque namespace use', () => {
    const root = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'src/barrel.ts': "export * from './leaf';\n",
      'test/static.test.ts': "import * as ns from '../src/barrel'; expect(ns.value).toBe(1);\n",
      'test/bracket.test.ts': "import * as ns from '../src/barrel'; expect(ns['value']).toBe(1);\n",
      'test/opaque.test.ts': "import * as ns from '../src/barrel'; consume(ns);\n",
      'test/direct-opaque.test.ts': "import * as ns from '../src/leaf'; consume(ns);\n",
    });

    expect(relation(root, 'test/static.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'matched', bindings: ['ns'],
    });
    expect(relation(root, 'test/bracket.test.ts', 'src/leaf.ts').status).toBe('matched');
    expect(relation(root, 'test/opaque.test.ts', 'src/leaf.ts').status).toBe('indeterminate');
    expect(relation(root, 'test/direct-opaque.test.ts', 'src/leaf.ts').status).toBe('indeterminate');
  });

  it('follows an exported namespace to its transitive runtime module', () => {
    const root = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'src/inner.ts': "export * from './leaf';\n",
      'src/outer.ts': "export * as values from './inner';\n",
      'test/value.test.ts': "import { values } from '../src/outer'; expect(values.value).toBe(1);\n",
    });

    expect(relation(root, 'test/value.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'matched',
      paths: [['test/value.test.ts', 'src/outer.ts', 'src/inner.ts', 'src/leaf.ts']],
    });
  });

  it('supports basic CommonJS named re-exports and destructured consumers', () => {
    const root = project({
      'src/leaf.cjs': 'exports.value = 1;\n',
      'src/barrel.cjs': "exports.value = require('./leaf').value;\n",
      'test/value.test.cjs': "const { value: subject } = require('../src/barrel'); void subject;\n",
    });

    expect(relation(root, 'test/value.test.cjs', 'src/leaf.cjs')).toMatchObject({
      status: 'matched', bindings: ['subject'],
    });
  });

  it('fails closed for reached generated CommonJS export mutations', () => {
    const root = project({
      'src/leaf.cjs': 'exports.value = 1;\n',
      'src/define.cjs': 'const leaf = require("./leaf"); Object.defineProperty(exports, "value", { enumerable: true, get: () => leaf.value });\n',
      'src/star.cjs': '__exportStar(require("./leaf"), exports);\n',
      'src/computed.cjs': 'exports["value"] = require("./leaf").value;\n',
      'src/spread.cjs': 'module.exports = { ...require("./leaf") };\n',
      'test/define.test.cjs': 'const { value } = require("../src/define"); void value;\n',
      'test/star.test.cjs': 'const { value } = require("../src/star"); void value;\n',
      'test/computed.test.cjs': 'const { value } = require("../src/computed"); void value;\n',
      'test/spread.test.cjs': 'const { value } = require("../src/spread"); void value;\n',
    });

    for (const name of ['define', 'star', 'computed', 'spread']) {
      expect(relation(root, `test/${name}.test.cjs`, 'src/leaf.cjs')).toMatchObject({
        status: 'indeterminate',
        reason: 'unsupported-syntax',
      });
    }
  });

  it('resolves CommonJS object-literal export shorthand by symbol', () => {
    const root = project({
      'src/leaf.cjs': 'function value() { return 1; }\nfunction other() { return 2; }\nmodule.exports = { value, other };\n',
      'test/value.test.cjs': "const { value } = require('../src/leaf'); void value;\n",
      'test/other.test.cjs': "const { other } = require('../src/leaf'); void other;\n",
    });
    expect(relation(root, 'test/value.test.cjs', 'src/leaf.cjs')).toMatchObject({ status: 'matched', bindings: ['value'] });
    expect(relation(root, 'test/other.test.cjs', 'src/leaf.cjs')).toMatchObject({ status: 'matched', bindings: ['other'] });
  });

  it('follows CommonJS local forwarding and property consumers', () => {
    const root = project({
      'src/leaf.cjs': 'exports.value = 1;\n',
      'src/barrel.cjs': "const { value: local } = require('./leaf'); exports.publicValue = local;\n",
      'test/value.test.cjs': "const subject = require('../src/barrel').publicValue; void subject;\n",
    });

    expect(relation(root, 'test/value.test.cjs', 'src/leaf.cjs')).toMatchObject({
      status: 'matched', bindings: ['subject'],
    });
  });

  it('treats side-effect imports as runtime reachability', () => {
    const root = project({
      'src/leaf.js': 'globalThis.loaded = true;\n',
      'src/barrel.js': "import './leaf.js';\n",
      'test/side-effect.test.js': "import '../src/barrel.js';\n",
    });

    expect(relation(root, 'test/side-effect.test.js', 'src/leaf.js')).toMatchObject({
      status: 'matched', bindings: [],
      paths: [['test/side-effect.test.js', 'src/barrel.js', 'src/leaf.js']],
    });
  });

  it('fails closed on extension ambiguity and exact graph bounds', () => {
    expect(IMPORT_LIMITS).toEqual({
      maxFileBytes: 1_048_576,
      maxDepth: 32,
      maxModules: 256,
      maxEdges: 1_024,
      maxTotalBytes: 16_777_216,
      maxWitnessPaths: 32,
    });
    const ambiguous = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'src/leaf.js': 'export const value = 2;\n',
      'test/value.test.ts': "import { value } from '../src/leaf'; void value;\n",
    });
    expect(relation(ambiguous, 'test/value.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'indeterminate', reason: 'ambiguous-resolution',
    });

    const deep = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'src/two.ts': "export { value } from './leaf';\n",
      'src/one.ts': "export { value } from './two';\n",
      'test/value.test.ts': "import { value } from '../src/one'; void value;\n",
    });
    expect(relation(deep, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxDepth: 1 },
    })).toMatchObject({ status: 'indeterminate', reason: 'graph-limit' });
    expect(relation(deep, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxModules: 1 },
    })).toMatchObject({ status: 'indeterminate', reason: 'graph-limit' });
    expect(relation(deep, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxEdges: 1 },
    })).toMatchObject({ status: 'indeterminate', reason: 'graph-limit' });
    expect(relation(deep, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxFileBytes: 8 },
    })).toMatchObject({ status: 'indeterminate', reason: 'graph-limit' });
    expect(relation(deep, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxTotalBytes: 8 },
    })).toMatchObject({ status: 'indeterminate', reason: 'graph-limit' });

    const witnesses = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'src/one.ts': "export { value } from './leaf';\n",
      'src/two.ts': "export { value } from './leaf';\n",
      'test/value.test.ts': "import { value as one } from '../src/one'; import { value as two } from '../src/two'; void one; void two;\n",
    });
    expect(relation(witnesses, 'test/value.test.ts', 'src/leaf.ts', {
      limits: { ...IMPORT_LIMITS, maxWitnessPaths: 1 },
    })).toMatchObject({ status: 'matched', paths: [['test/value.test.ts', 'src/one.ts', 'src/leaf.ts']] });
  });

  it('fails closed when a reached importer uses unsupported module syntax', () => {
    const root = project({
      'src/leaf.ts': 'export const value = 1;\n',
      'test/value.test.ts': "import value = require('../src/leaf'); void value;\n",
    });

    expect(relation(root, 'test/value.test.ts', 'src/leaf.ts')).toMatchObject({
      status: 'indeterminate', reason: 'unsupported-syntax',
    });
  });

  it('records alias configuration consulted by a negative bare import', () => {
    const root = project({
      'tsconfig.json': '{}\n',
      'src/leaf.ts': 'export const value = 1;\n',
      'test/value.test.ts': "import { value } from '@future/leaf'; void value;\n",
    });

    expect(relation(root, 'test/value.test.ts', 'src/leaf.ts', {
      aliases: [],
      configFiles: ['tsconfig.json'],
    })).toEqual({
      status: 'not-matched',
      bindings: [],
      paths: [],
      dependencies: ['tsconfig.json'],
    });
  });
});
