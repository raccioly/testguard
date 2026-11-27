// Issue #334: defender discovery followed relative imports, tsconfig `paths`,
// vite aliases and package.json `imports`, but not Jest's own module
// resolution. A test that imports its subject through a `moduleNameMapper`
// name (`require('c/price')`) was green under Jest and still reported NOCOVER.
// The static layer reads a literal `moduleNameMapper` as alias rules; a mapper
// it cannot evaluate makes the closure indeterminate, never smaller.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashDiscoveryConfigs } from '../src/probe/runners/discovery.mjs';
import { fileImportRelation, loadAliases, projectImportResolver, resetAliasCache } from '../src/probe/rank.mjs';
import { instrumentOf } from '../src/probe/dependencies.mjs';
import { discoverDefendersDetailed } from '../src/probe/discover.mjs';

const roots = [];
afterEach(() => { resetAliasCache(); while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
function project(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-jest-')));
  roots.push(root);
  for (const [name, text] of Object.entries({
    'package.json': '{ "name": "demo", "private": true }',
    'src/price/price.js': "function label(price) {\n  if (price > 100) {\n    return 'expensive';\n  }\n  return 'cheap';\n}\nmodule.exports = { label };\n",
    'test/price.test.js': "const { label } = require('c/price');\ntest('labels', () => { expect(label(500)).toBe('expensive'); });\n",
    ...files,
  })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const TEST = (root) => join(root, 'test/price.test.js');
const closureOf = (root, test = TEST(root)) => projectImportResolver(root).closure([test]);
const jestConfig = (body) => `module.exports = { testEnvironment: 'node', ${body} };\n`;
const MAPPER = "moduleNameMapper: { '^c/(.*)$': '<rootDir>/src/$1/$1' }";

describe('a literal moduleNameMapper resolves like a tsconfig paths entry', () => {
  it('the issue: jest.config.js `^c/(.*)$` -> `<rootDir>/src/$1/$1` reaches the subject', () => {
    const root = project({ 'jest.config.js': jestConfig(MAPPER) });
    const closure = closureOf(root);
    expect(closure.status).toBe('complete');
    expect(closure.files).toContain('src/price/price.js');
    expect(fileImportRelation(root, TEST(root), 'src/price/price.js').status).toBe('matched');
  });

  it.each([
    ['jest.config.js', jestConfig(MAPPER)],
    ['jest.config.cjs', jestConfig(MAPPER)],
    ['jest.config.mjs', `export default { ${MAPPER} };\n`],
    ['jest.config.ts', `import type { Config } from 'jest';\nconst config: Config = { ${MAPPER} };\nexport default config;\n`],
    ['jest.config.json', JSON.stringify({ moduleNameMapper: { '^c/(.*)$': '<rootDir>/src/$1/$1' } })],
    ['package.json', JSON.stringify({ name: 'demo', jest: { moduleNameMapper: { '^c/(.*)$': '<rootDir>/src/$1/$1' } } })],
  ])('reads the mapper from %s', (file, text) => {
    const root = project({ [file]: text });
    const closure = closureOf(root);
    expect(closure.status).toBe('complete');
    expect(closure.files).toContain('src/price/price.js');
  });

  it('handles an exact-string key, an array value (first target that exists) and an escaped slash', () => {
    const root = project({
      'jest.config.js': jestConfig("moduleNameMapper: { '^price$': ['<rootDir>/missing/price', '<rootDir>/src/price/price'], '^@app\\\\/(.*)$': '<rootDir>/src/$1/$1' }"),
      'test/exact.test.js': "const a = require('price');\n",
      'test/escaped.test.js': "const a = require('@app/price');\n",
    });
    expect(closureOf(root, join(root, 'test/exact.test.js')).files).toContain('src/price/price.js');
    expect(closureOf(root, join(root, 'test/escaped.test.js')).files).toContain('src/price/price.js');
  });

  it('a capture followed by a literal suffix keeps the suffix', () => {
    const root = project({
      'jest.config.js': jestConfig("moduleNameMapper: { '^c/(.*)/index$': '<rootDir>/src/$1/$1' }"),
      'test/suffix.test.js': "const a = require('c/price/index');\n",
    });
    const rule = loadAliases(root).find((r) => r.wildcard);
    expect([rule.prefix, rule.suffix]).toEqual(['c/', '/index']);
    expect(closureOf(root, join(root, 'test/suffix.test.js')).files).toContain('src/price/price.js');
  });

  it('a mapped name whose file does not exist is indeterminate, not an absent import', () => {
    const root = project({ 'jest.config.js': jestConfig(MAPPER), 'test/ghost.test.js': "require('c/ghost');\n" });
    expect(closureOf(root, join(root, 'test/ghost.test.js')).status).toBe('indeterminate');
  });

  it('a target that is a package (identity-obj-proxy style) is outside the project, like any package', () => {
    const root = project({ 'jest.config.js': jestConfig("moduleNameMapper: { '^style-stub$': 'identity-obj-proxy', '^c/(.*)$': '<rootDir>/src/$1/$1' }"), 'test/pkg.test.js': "require('style-stub');\n" });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('complete');
  });

  it('a style/asset regex stub does not make every package indeterminate', () => {
    const root = project({
      'jest.config.js': jestConfig("moduleNameMapper: { '\\\\.(css|less|png)$': '<rootDir>/test/stub.js', '^c/(.*)$': '<rootDir>/src/$1/$1' }"),
      'test/stub.js': 'module.exports = {};\n',
      'test/pkg.test.js': "require('left-pad');\nrequire('c/price');\n",
    });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('complete');
  });

  it('records the jest config as an alias dependency, so a change to it invalidates reuse', () => {
    const root = project({ 'jest.config.js': jestConfig(MAPPER) });
    expect(fileImportRelation(root, TEST(root), 'src/price/price.js').dependencies).toContain('jest.config.js');
  });
});

describe('defender discovery uses the mapper', () => {
  it('finds the test Jest runs, instead of NOCOVER', () => {
    const root = project({ 'jest.config.js': jestConfig(MAPPER) });
    const found = discoverDefendersDetailed(root, 'src/price/price.js');
    expect(found.canDetect).toEqual(['test/price.test.js']);
    expect(found.indeterminate).toEqual([]);
  });

  it('reports the test as indeterminate, not absent, when the mapper cannot be read', () => {
    const root = project({ 'jest.config.js': jestConfig('moduleNameMapper: buildMapper()') });
    const found = discoverDefendersDetailed(root, 'src/price/price.js');
    expect(found.canDetect).toEqual([]);
    expect(found.indeterminate.map((entry) => entry.file)).toEqual(['test/price.test.js']);
  });
});

describe('a mapper the reader cannot evaluate is indeterminate, never a confident NOCOVER', () => {
  const CASES = {
    'a variable': 'moduleNameMapper: mappings',
    'a function call': 'moduleNameMapper: buildMapper()',
    'a spread inside the mapper': "moduleNameMapper: { ...base, '^c/(.*)$': '<rootDir>/src/$1/$1' }",
    'a value that is not a string': "moduleNameMapper: { '^c/(.*)$': pathFor('c') }",
    'a regex it cannot translate': "moduleNameMapper: { '^(?:c|d)/(.*)$': '<rootDir>/src/$1/$1' }",
    'an unanchored regex': "moduleNameMapper: { 'c/(.*)$': '<rootDir>/src/$1/$1' }",
    'a capture it cannot place': "moduleNameMapper: { '^c/(.*)$': '<rootDir>/src/$1/$2' }",
    'a shorthand property': 'moduleNameMapper',
    'a custom resolver': `resolver: './resolver.js', ${MAPPER}`,
    'a preset that adds its own mapper': `preset: '@vendor/jest-preset', ${MAPPER}`,
    'modulePaths': `modulePaths: ['<rootDir>/src'], ${MAPPER}`,
    'moduleDirectories': `moduleDirectories: ['node_modules', 'src'], ${MAPPER}`,
    'a config spread': `...shared, ${MAPPER}`,
    'a rootDir override': `rootDir: 'app', ${MAPPER}`,
    'projects': `projects: ['<rootDir>/a'], ${MAPPER}`,
  };
  for (const [label, body] of Object.entries(CASES)) {
    it(label, () => {
      const root = project({ 'jest.config.js': `const mappings = {};\n${jestConfig(body)}`, 'test/pkg.test.js': "require('left-pad');\nrequire('c/price');\n" });
      expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('indeterminate');
      expect(fileImportRelation(root, TEST(root), 'src/price/price.js').status).not.toBe('not-matched');
    });
  }

  it('an exported config produced by a call (createJestConfig(...)) is not a literal', () => {
    const root = project({ 'jest.config.js': 'const make = require("./make");\nmodule.exports = make({});\n', 'test/pkg.test.js': "require('left-pad');\n" });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('indeterminate');
  });

  it('a config that exports a bound literal object is read', () => {
    const root = project({ 'jest.config.js': `const config = { ${MAPPER} };\nmodule.exports = config;\n` });
    expect(closureOf(root).status).toBe('complete');
  });

  it('a ts-jest preset adds no mapper and stays readable', () => {
    const root = project({ 'jest.config.js': jestConfig(`preset: 'ts-jest', ${MAPPER}`), 'test/pkg.test.js': "require('left-pad');\n" });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('complete');
  });

  it('a rule that Jest would try first but the resolver would rank second makes the mapper indeterminate', () => {
    const root = project({
      'jest.config.js': jestConfig("moduleNameMapper: { '^c/(.*)$': '<rootDir>/src/$1/$1', '^c/special/(.*)$': '<rootDir>/other/$1' }"),
      'other/thing.js': 'module.exports = {};\n', // the file the resolver alone would pick; Jest picks the first rule: `src/special/thing/special/thing`
      'test/pkg.test.js': "require('c/special/thing');\n",
    });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('indeterminate');
  });

  it('a package.json#jest that is not a plain object is not guessed', () => {
    const root = project({ 'package.json': '{ "name": "demo", "jest": "./jest.shared.json" }', 'test/pkg.test.js': "require('left-pad');\n" });
    expect(closureOf(root, join(root, 'test/pkg.test.js')).status).toBe('indeterminate');
  });
});

describe('the jest config is a discovery input', () => {
  it('a change to moduleNameMapper changes the discovery config hash and the instrument digest', () => {
    const root = project({ 'jest.config.js': jestConfig(MAPPER) });
    const files = ['jest.config.js', 'jest.config.json'];
    const entry = () => hashDiscoveryConfigs(root, files).find((e) => e.path === 'jest.config.js').sha256;
    const digest = () => { resetAliasCache(); return instrumentOf(root, '0.0.0').digest; };
    const before = [entry(), digest()];
    writeFileSync(join(root, 'jest.config.js'), jestConfig("moduleNameMapper: { '^c/(.*)$': '<rootDir>/lib/$1/$1' }"));
    expect([entry(), digest()].map((h, i) => h !== before[i])).toEqual([true, true]);
  });
});
