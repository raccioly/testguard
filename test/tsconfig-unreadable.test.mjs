// Issue #330 (remaining parts): a tsconfig/jsconfig that cannot be read makes
// the alias closure indeterminate, never smaller; a discovery failure caused by
// an unparsable config says so and gives no dependency advice; the Angular-style
// commented header is accepted by discovery in all three tsconfig files.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashDiscoveryConfigs } from '../src/probe/runners/discovery.mjs';
import { runnerUnresolvableMessage, selectRunner } from '../src/probe/runners/index.mjs';
import { discoveryIndeterminateRecord } from '../src/probe/probe.mjs';
import { loadAliases, projectImportResolver, resetAliasCache, unreadableAliasConfigs } from '../src/probe/rank.mjs';

const roots = [];
afterEach(() => { resetAliasCache(); while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
function project(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-tsc-')));
  roots.push(root);
  for (const [name, text] of Object.entries({ 'package.json': '{"name":"p","private":true}', ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const SOURCES = {
  'src/app/price.ts': 'export const label = 1;\n',
  'test/price.test.ts': "import { label } from '@app/price';\nvoid label;\n",
};
const ANGULAR_HEADER = '/* To learn more about this file see: https://angular.io/config/tsconfig. */\n';

describe('an unreadable tsconfig is an opaque alias map, never a dropped one', () => {
  it('adds a catch-all rule with no target, and the closure is indeterminate', () => {
    const root = project({ ...SOURCES, 'tsconfig.json': '{ "compilerOptions": { "paths": { "@app/*": ["src/app/*"] } ' });
    expect(loadAliases(root).some((rule) => rule.opaque && rule.prefix === '' && rule.targets.length === 0)).toBe(true);
    expect(projectImportResolver(root).closure([join(root, 'test/price.test.ts')]).status).toBe('indeterminate');
  });
  it('an unreadable extended config does the same', () => {
    const root = project({ ...SOURCES, 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }', 'tsconfig.base.json': '{ "compilerOptions": ' });
    expect(projectImportResolver(root).closure([join(root, 'test/price.test.ts')]).status).toBe('indeterminate');
  });
  it('names the unreadable file in the indeterminate record message', () => {
    const root = project({ ...SOURCES, 'tsconfig.json': '{ "compilerOptions": ' });
    const unreadableConfigs = unreadableAliasConfigs(root);
    expect(unreadableConfigs).toEqual(['tsconfig.json']);
    const record = discoveryIndeterminateRecord({
      claim: { id: 'C', statement: 's', severity: 'medium', source: { kind: 'spec', ref: 'x' }, producedBy: { producer: 'agent', by: 'claude' } },
      fault: { id: 'F1', file: 'src/app/price.ts' },
      defenders: [],
      inputs: {},
      indeterminate: [{ file: 'test/price.test.ts', reason: 'unreadable-module', issues: [] }],
      unreadableConfigs,
    });
    expect(record.detail.reason).toBe('defender-discovery-indeterminate');
    expect(record.detail.message).toMatch(/unreadable config: tsconfig\.json/);
    expect(record.detail.message.length).toBeLessThanOrEqual(1024);
  });
  it('a readable config (comments, trailing commas, an include glob) still resolves the alias', () => {
    const root = project({
      ...SOURCES,
      'tsconfig.json': `${ANGULAR_HEADER}{\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], }, },\n  "include": ["src/**/*.ts"], // glob\n}\n`,
    });
    const closure = projectImportResolver(root).closure([join(root, 'test/price.test.ts')]);
    expect(closure.status).toBe('complete');
    expect([...closure.files].some((file) => file.endsWith('src/app/price.ts'))).toBe(true);
  });
});

describe('discovery reads an Angular-style commented tsconfig family', () => {
  it('accepts the header in tsconfig.json, tsconfig.app.json and tsconfig.spec.json', async () => {
    const config = (extra) => `${ANGULAR_HEADER}{\n  "compilerOptions": { "strict": true },\n  ${extra}\n}\n`;
    const root = project({
      'tsconfig.json': config('"references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.spec.json" }]'),
      'tsconfig.app.json': config('"extends": "./tsconfig.json"'),
      'tsconfig.spec.json': config('"extends": "./tsconfig.json"'),
      'tests/test_calc.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n',
    });
    expect(() => hashDiscoveryConfigs(root, ['tsconfig.json'])).not.toThrow();
    const sel = await selectRunner({ projectDir: root, sourceDir: root, name: 'python' });
    expect(sel.error).toBeUndefined();
  });
});

describe('a discovery failure caused by an unparsable config', () => {
  it('is flagged, and its message gives no dependency advice', async () => {
    const root = project({ 'tsconfig.json': '{ "compilerOptions": ', 'tests/test_calc.py': 'import unittest\n' });
    const sel = await selectRunner({ projectDir: root, sourceDir: root, name: 'python' });
    expect(sel.error).toMatch(/tsconfig\.json is not valid JSON/);
    expect(sel.configError).toBe(true);
    const message = runnerUnresolvableMessage({ sel, mode: 'worktree' });
    expect(message).toMatch(/tsconfig\.json/);
    expect(message).not.toMatch(/--node-modules|--in-place|install them/);
  });
  it('keeps the dependency advice when the cause is not a config', () => {
    const sel = { error: 'jest: not resolvable' };
    expect(runnerUnresolvableMessage({ sel, mode: 'worktree' })).toMatch(/--node-modules/);
    expect(runnerUnresolvableMessage({ sel, mode: 'in-place' })).toMatch(/install them first/);
  });
});
