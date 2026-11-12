// Issue #264: a vite/vitest alias written the common way,
// `fileURLToPath(new URL('./src', import.meta.url))`, refused the whole probe
// (exit 2): discovery took the string './src' for a module, resolved it to
// src/index.ts, and could not resolve `@/errors` inside it. And an alias whose
// target the reader could not evaluate was silently dropped, so its
// specifiers read as packages: outside the closure, which is the unsound side.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashDiscoveryConfigs } from '../src/probe/runners/discovery.mjs';
import { loadAliases, projectImportResolver, resetAliasCache } from '../src/probe/rank.mjs';

const VITEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vitest');
const roots = [];
afterEach(() => { resetAliasCache(); while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
function project(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-alias-')));
  roots.push(root);
  for (const [name, text] of Object.entries({ 'package.json': '{"type":"module"}', ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  // The config imports vitest/config; discovery hashes that package, so it must resolve.
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(realpathSync(VITEST), join(root, 'node_modules', 'vitest'), 'dir');
  return root;
}
const config = (alias, preamble = '') => `import { fileURLToPath } from 'node:url';\nimport path, { dirname, join, resolve } from 'node:path';\nimport { defineConfig } from 'vitest/config';\n${preamble}\nexport default defineConfig({\n  resolve: { alias: ${alias} },\n  test: { include: ['test/**/*.test.ts'] },\n});\n`;
const SOURCES = (dir) => ({
  [`${dir}/index.ts`]: "export * from '@/errors';\nexport * from '@/stock';\n",
  [`${dir}/errors.ts`]: 'export class StockError extends Error {}\n',
  [`${dir}/stock.ts`]: "import { StockError } from '@/errors';\nexport const take = (n: number) => { if (n < 0) throw new StockError(); return n; };\n",
  'test/stock.test.ts': "import { take } from '@/stock';\n",
});

describe('the vite/vitest alias forms the reader evaluates', () => {
  it.each([
    ['fileURLToPath(new URL(\'./src\', import.meta.url))', "{ '@': fileURLToPath(new URL('./src', import.meta.url)) }", '', 'src'],
    ['fileURLToPath(new URL(\'./src/\', import.meta.url))', "{ '@': fileURLToPath(new URL('./src/', import.meta.url)) }", '', 'src'],
    ['new URL(…).pathname', "{ '@': new URL('./lib', import.meta.url).pathname }", '', 'lib'],
    ['path.resolve(__dirname, \'lib\')', "{ '@': path.resolve(__dirname, 'lib') }", '', 'lib'],
    ['resolve(__dirname, \'./code/src\')', "{ '@': resolve(__dirname, './code/src') }", '', 'code/src'],
    ['join(root, \'lib\') with root = dirname(fileURLToPath(import.meta.url))', "{ '@': join(root, 'lib') }", 'const root = dirname(fileURLToPath(import.meta.url));', 'lib'],
    ['path.join(process.cwd(), \'lib\')', "{ '@': path.join(process.cwd(), 'lib') }", '', 'lib'],
    ['import.meta.dirname', "{ '@': join(import.meta.dirname, 'lib') }", '', 'lib'],
    ['a plain relative string', "{ '@': './lib' }", '', 'lib'],
    ['the array form', "[{ find: '@', replacement: fileURLToPath(new URL('./lib', import.meta.url)) }]", '', 'lib'],
  ])('%s', (label, alias, preamble, dir) => {
    const root = project({ 'vitest.config.ts': config(alias, preamble), ...SOURCES(dir) });
    const rule = loadAliases(root).find((r) => r.prefix === '@' && !r.wildcard);
    expect(rule?.targets, label).toEqual([join(root, dir)]);
    const closure = projectImportResolver(root).closure([join(root, 'test/stock.test.ts')]);
    expect(closure.status, label).toBe('complete');
    expect(closure.files, label).toEqual(expect.arrayContaining([`${dir}/stock.ts`, `${dir}/errors.ts`]));
  });
});

describe('discovery does not refuse the run over an alias it reads as a path', () => {
  it.each([
    "{ '@': fileURLToPath(new URL('./src', import.meta.url)) }",
    "{ '@': fileURLToPath(new URL('./src/', import.meta.url)) }",
  ])('hashes the config of %s without following ./src as a module', (alias) => {
    const root = project({ 'vitest.config.ts': config(alias), ...SOURCES('src') });
    const entries = hashDiscoveryConfigs(root, ['vitest.config.ts']);
    expect(entries.map((entry) => entry.path)).toContain('vitest.config.ts');
    expect(entries.map((entry) => entry.path)).not.toContain('src/index.ts');
  });

  it('still follows a setup file that imports through the alias', () => {
    const root = project({
      'vitest.config.ts': config("{ '@': fileURLToPath(new URL('./src', import.meta.url)) }").replace("include: ['test/**/*.test.ts']", "include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts']"),
      'test/setup.ts': "import '@/errors';\n",
      ...SOURCES('src'),
    });
    const paths = hashDiscoveryConfigs(root, ['vitest.config.ts']).map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['test/setup.ts', 'src/errors.ts']));
  });
});

describe('an alias the reader cannot evaluate makes the closure indeterminate, never smaller', () => {
  it('a value it cannot evaluate: the files that use the alias are indeterminate, the others complete', () => {
    const root = project({
      'vitest.config.ts': config("{ '@': computeRoot('src'), '~': fileURLToPath(new URL('./src', import.meta.url)) }"),
      ...SOURCES('src'),
      'test/plain.test.ts': "import { take } from '~/stock';\n",
    });
    const resolver = projectImportResolver(root);
    const using = resolver.closure([join(root, 'test/stock.test.ts')]);
    expect(using.status).toBe('indeterminate');
    expect(using.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unreadable-module', specifier: '@/stock' })]));
    // `~` resolves to src, whose stock.ts imports '@/errors': indeterminate too.
    expect(resolver.closure([join(root, 'test/plain.test.ts')]).status).toBe('indeterminate');
    expect(resolver.closure([join(root, 'src/errors.ts')]).status).toBe('complete');
  });

  it('an alias map it cannot read at all (a variable, a spread, a regex find) makes every bare specifier indeterminate', () => {
    for (const alias of ['aliases', "{ ...shared, '@': './src' }", "[{ find: /^@\\//, replacement: './src/' }]"]) {
      resetAliasCache();
      const root = project({ 'vitest.config.ts': config(alias), ...SOURCES('src'), 'src/pure.ts': 'export const pure = 1;\n', 'test/pkg.test.ts': "import { describe } from 'vitest';\nimport { pure } from '../src/pure';\n" });
      const resolver = projectImportResolver(root);
      expect(resolver.closure([join(root, 'test/pkg.test.ts')]).status, alias).toBe('indeterminate');
      expect(resolver.closure([join(root, 'src/errors.ts')]).status, alias).toBe('complete');
    }
  });
});
