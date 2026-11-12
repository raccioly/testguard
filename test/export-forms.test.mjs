// Issues #266 and #267: ordinary TypeScript and CommonJS export forms made a
// module `unsupported-syntax`, and with it every importer's closure
// indeterminate: no reuse, and `probe --changed` selected every claim. The
// reader must read them; where it truly cannot, it must stay uncertain (the
// closure larger or indeterminate, never smaller).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createImportResolver, parseModuleSource } from '../src/probe/imports.mjs';

/** name → origins, as the resolver sees them after its post-pass. */
const exportsOf = (source) => {
  const parsed = parseModuleSource(source);
  return { uncertain: parsed.uncertain, exports: Object.fromEntries([...parsed.explicit].map(([name, origins]) => [name, origins.map((o) => o.kind === 'terminal' ? 'terminal' : `${o.kind}:${o.specifier ?? o.local}${o.imported ? `#${o.imported}` : ''}`)])), runtime: parsed.runtime };
};

// [label, source, exported names → origin kinds (exact), runtime specifiers]
const READ = [
  // TypeScript declarations: a type exports no runtime binding.
  ['export interface', 'export interface E { a: number; b(): void }\nexport const x = 1;\n', { x: ['terminal'] }],
  ['export interface extending, generic', 'export interface E<T> extends Base<T>, Other { a: T }\n', {}],
  ['export type alias', 'export type A = "x" | "y";\nexport const y = 2;\n', { y: ['terminal'] }],
  ['export type with an object body', 'export type P = { a: number; b: string };\nexport function f() {}\n', { f: ['terminal'] }],
  ['export declare const', 'export declare const VERSION: string;\nexport const z = 1;\n', { z: ['terminal'] }],
  ['export declare function / class / namespace / global', 'export declare function f(a: number): void;\nexport declare class C {}\nexport declare namespace N { const a: number; }\ndeclare global { interface W {} }\nexport const k = 1;\n', { k: ['terminal'] }],
  ['export enum (a runtime object)', 'export enum Color { Red, Green }\n', { Color: ['terminal'] }],
  ['export const enum', 'export const enum Dir { Up = 1 }\n', { Dir: ['terminal'] }],
  ['export declare enum (ambient)', 'export declare enum Amb { A }\nexport const q = 1;\n', { q: ['terminal'] }],
  ['export abstract class', 'export abstract class Shape { abstract area(): number; }\n', { Shape: ['terminal'] }],
  ['export namespace (runtime)', 'export namespace Util { export const a = 1; }\n', { Util: ['terminal'] }],
  ['export module (legacy namespace)', 'export module Legacy { export const b = 2; }\n', { Legacy: ['terminal'] }],
  ['export as namespace (UMD typing)', 'export as namespace MyLib;\nexport const m = 1;\n', { m: ['terminal'] }],
  ['export type { X } from', "export type { T } from './types';\nexport { v } from './values';\n", { v: ['remote:./values#v'] }, ['./values']],
  ['export { type X, Y }', "import { a, type B } from './a';\nexport { type B, a };\n", { a: ['remote:./a#a'] }, ['./a']],
  ['export { type } (a binding named type)', 'const type = 1;\nexport { type };\n', { type: ['terminal'] }],
  ['import type', "import type { T } from './types';\nimport { v } from './values';\nexport const w = v;\n", { w: ['terminal'] }, ['./values']],
  ['import type X default-named `type`', "import type from './type-module';\nexport const t = type;\n", { t: ['terminal'] }, ['./type-module']],
  ['satisfies', "export const config = { a: 1 } satisfies Config;\nexport default { b: 2 } satisfies Config;\n", { config: ['terminal'], default: ['terminal'] }],
  ['decorated class', '@Injectable()\nexport class Service {}\nexport @sealed class Sealed {}\nexport default @dec() class {}\n', { Service: ['terminal'], Sealed: ['terminal'], default: ['terminal'] }],
  ['generator functions', 'export function* gen() {}\nexport async function* agen() {}\n', { gen: ['terminal'], agen: ['terminal'] }],
  ['several declarators', 'export const a = 1, b = [1, 2], c = f(x, y);\n', { a: ['terminal'], b: ['terminal'], c: ['terminal'] }],
  ['destructuring declaration', 'export const { a, b: renamed, ...rest } = obj;\nexport const [first, , third] = list;\n', { a: ['terminal'], renamed: ['terminal'], rest: ['terminal'], first: ['terminal'], third: ['terminal'] }],
  // CommonJS object-literal exports.
  ['module.exports = { X: call() }', "const define = (n) => n;\nmodule.exports = {\n  MissingValueError: define('MissingValueError'),\n  TemplateSyntaxError: define('TemplateSyntaxError'),\n};\n", { MissingValueError: ['terminal'], TemplateSyntaxError: ['terminal'] }],
  ['module.exports = { literals, functions, methods }', "module.exports = { n: 1, s: 'x', arr: [1, 2], obj: { a: 1 }, fn: () => 1, fe: function () {}, m() { return 1; }, async am() {}, 'quoted-key': 2, tpl: `a${b}` };\n", { n: ['terminal'], s: ['terminal'], arr: ['terminal'], obj: ['terminal'], fn: ['terminal'], fe: ['terminal'], m: ['terminal'], am: ['terminal'], 'quoted-key': ['terminal'], tpl: ['terminal'] }],
  ['module.exports = { X: require(x) }', "module.exports = { helpers: require('./helpers'), one: require('./one').one };\n", { helpers: ['namespace:./helpers'], one: ['remote:./one#one'] }, ['./helpers', './one']],
  ['module.exports = { X: ns.Y } with ns imported', "const ns = require('./ns');\nmodule.exports = { y: ns.y };\n", { y: ['remote:./ns#y'] }, ['./ns']],
  ['module.exports = { X: local.Y } with a local object', 'const local = { y: 1 };\nmodule.exports = { y: local.y };\n', { y: ['terminal'] }],
  ['module.exports = { shorthand, X: imported }', "const { a } = require('./a');\nconst b = 2;\nmodule.exports = { a, b, c: a };\n", { a: ['remote:./a#a'], b: ['terminal'], c: ['remote:./a#a'] }, ['./a']],
];

// Forms the reader must NOT pretend to understand: uncertain, so every
// importer's closure is indeterminate (larger is safe, smaller is not).
const UNCERTAIN = [
  ['spread in an exported object', "const base = require('./base');\nmodule.exports = { ...base, x: 1 };\n"],
  ['computed key', 'module.exports = { [name]: 1 };\n'],
  ['getter', 'module.exports = { get x() { return 1; } };\n'],
  ['a require hidden inside a call', "module.exports = { x: wrap(require('./x')) };\n"],
  ['a member of a named import', "const { a } = require('./a');\nmodule.exports = { y: a.y };\n"],
  ['export = (TypeScript CommonJS)', 'export = thing;\n'],
  ['export import X = require()', "export import X = require('./x');\n"],
  ['a whole-module export of a call', 'module.exports = build();\n'],
];

describe('export forms the reader reads (#266, #267)', () => {
  it.each(READ)('%s', (label, source, expected, runtime = []) => {
    const result = exportsOf(source);
    expect(result.uncertain, label).toEqual([]);
    expect(result.exports, label).toEqual(expected);
    for (const specifier of runtime) expect(result.runtime, label).toContain(specifier);
  });
});

describe('export forms the reader refuses to guess (stays uncertain)', () => {
  it.each(UNCERTAIN)('%s', (label, source) => {
    expect(exportsOf(source).uncertain, label).toEqual(['unsupported-syntax']);
  });
});

describe('an importer of such a module keeps a complete closure', () => {
  const roots = [];
  afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
  const project = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'tg-export-forms-'));
    roots.push(root);
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
    return root;
  };

  it('CommonJS errors module exporting { Name: define() }', () => {
    const root = project({
      'src/errors.js': "const define = (n) => class extends Error { name = n; };\nmodule.exports = { MissingValueError: define('MissingValueError') };\n",
      'src/footer.js': "const { MissingValueError } = require('./errors');\nmodule.exports = { footer: (a) => { if (!a) throw new MissingValueError(); return a; } };\n",
      'test/footer.test.js': "const { footer } = require('../src/footer');\ntest('x', () => expect(footer('a')).toBe('a'));\n",
    });
    const result = createImportResolver(root).closure([join(root, 'test/footer.test.js')]);
    expect(result).toEqual({ status: 'complete', files: ['src/errors.js', 'src/footer.js', 'test/footer.test.js'] });
    const relation = createImportResolver(root).relation(join(root, 'test/footer.test.js'), 'src/footer.js');
    expect(relation.status).toBe('matched');
  });

  it('TypeScript module exporting an interface beside a value', () => {
    const root = project({
      'src/pricing.ts': 'export interface Price { amount: number }\nexport const price = (n: number): Price => ({ amount: n });\n',
      'test/pricing.test.ts': "import { price, type Price } from '../src/pricing';\nconst p: Price = price(1);\n",
    });
    const result = createImportResolver(root).closure([join(root, 'test/pricing.test.ts')]);
    expect(result).toEqual({ status: 'complete', files: ['src/pricing.ts', 'test/pricing.test.ts'] });
    expect(createImportResolver(root).relation(join(root, 'test/pricing.test.ts'), 'src/pricing.ts').status).toBe('matched');
  });
});
