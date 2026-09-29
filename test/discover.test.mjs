// @req FR-09
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDefenders, discoverDefendersDetailed } from '../src/probe/discover.mjs';
import { loadAliases, resetAliasCache } from '../src/probe/rank.mjs';

describe('discoverDefenders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-discover-'));
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}');
  writeFileSync(join(dir, 'src', 'lib', 'guard.ts'), 'export const g = 1;\n');
  writeFileSync(join(dir, 'src', 'lib', 'other.ts'), 'export const o = 1;\n');
  writeFileSync(join(dir, 'test', 'guard.test.ts'), "import { g } from '../src/lib/guard';\n");
  writeFileSync(join(dir, 'test', 'alias.test.ts'), "import { g } from '@/lib/guard';\n");
  writeFileSync(join(dir, 'test', 'other.test.ts'), "import { o } from '../src/lib/other';\n");
  mkdirSync(join(dir, 'checks'));
  writeFileSync(join(dir, 'checks', 'guard.case.mjs'), "import { g } from '../src/lib/guard';\n");
  it('returns the test files that import the target, by relative path or alias, and nothing else', () => {
    expect(discoverDefenders(dir, 'src/lib/guard.ts')).toEqual(['test/alias.test.ts', 'test/guard.test.ts']);
    expect(discoverDefenders(dir, 'src/lib/other.ts')).toEqual(['test/other.test.ts']);
    expect(discoverDefenders(dir, 'src/lib/nothing.ts')).toEqual([]);
  });

  it('uses an immutable explicit test universe verbatim, including config-defined names outside legacy globs', () => {
    const files = Object.freeze(['checks/guard.case.mjs']);
    const manifest = Object.freeze({ files });
    expect(discoverDefendersDetailed(dir, 'src/lib/guard.ts', manifest).importing).toEqual(['checks/guard.case.mjs']);
    expect(discoverDefendersDetailed(dir, 'src/lib/guard.ts', files).canDetect).toEqual(['checks/guard.case.mjs']);
    expect(files).toEqual(['checks/guard.case.mjs']);
    expect(() => discoverDefendersDetailed(dir, 'src/lib/guard.ts', ['checks/guard.case.mjs'])).toThrow(/immutable/i);
    expect(() => discoverDefendersDetailed(dir, 'src/lib/guard.ts', { files })).toThrow(/manifest must be immutable/i);
  });
});

describe('discoverDefenders — nested __tests__, tsconfig references, vite alias, and mocking files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-discover2-'));
  const write = (rel, text) => { mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  // Vite layout: the root tsconfig only references; paths live in tsconfig.app.json
  write('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }');
  write('tsconfig.app.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }');
  write('tsconfig.node.json', '{ "compilerOptions": { "strict": true } }');
  write('vitest.config.ts', "import path from 'node:path';\nexport default { resolve: { alias: { '~': path.resolve(__dirname, './src'), '#utils': path.resolve(__dirname, './src/utils') } }, test: {} };\n");
  write('src/utils/permissions.ts', 'export const can = () => true;\n');
  write('src/utils/__tests__/permissions.test.ts', "import { can } from '../permissions';\nit('x', () => expect(can()).toBe(true));\n");
  write('src/components/__tests__/Toolbar.test.tsx', "import { vi } from 'vitest';\nimport { can } from '@/utils/permissions';\nvi.mock('@/utils/permissions', () => ({ can: vi.fn(() => true) }));\nit('x', () => expect(1).toBe(1));\n");
  write('src/components/__tests__/Menu.test.tsx', "import { can } from '~/utils/permissions';\nit('x', () => expect(can()).toBe(true));\n");
  write('test/deep/nested/perm.test.ts', "import { can } from '../../../src/utils/permissions';\nit('x', () => expect(can()).toBe(true));\n");
  write('test/hash.test.ts', "import { can } from '#utils/permissions';\nit('x', () => expect(can()).toBe(true));\n");
  write('test/unrelated.test.ts', "import { other } from '../src/other';\n");
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); resetAliasCache(); });

  it('loads paths through references and vite aliases', () => {
    const prefixes = loadAliases(dir).map((r) => r.prefix).sort();
    expect(prefixes).toEqual(expect.arrayContaining(['@/', '~', '~/', '#utils', '#utils/']));
  });

  it('finds every importer — relative from nested __tests__, deep relative, referenced-tsconfig alias, vite alias — and excludes the one that mocks the target', () => {
    const d = discoverDefendersDetailed(dir, 'src/utils/permissions.ts');
    expect(d.importing).toEqual(['src/components/__tests__/Menu.test.tsx', 'src/components/__tests__/Toolbar.test.tsx', 'src/utils/__tests__/permissions.test.ts', 'test/deep/nested/perm.test.ts', 'test/hash.test.ts']);
    expect(d.mocking).toEqual(['src/components/__tests__/Toolbar.test.tsx']);
    expect(d.canDetect).toEqual(['src/components/__tests__/Menu.test.tsx', 'src/utils/__tests__/permissions.test.ts', 'test/deep/nested/perm.test.ts', 'test/hash.test.ts']);
    expect(d.signals).toEqual([{ file: 'src/components/__tests__/Toolbar.test.tsx', signal: 'mocked-never-asserted' }]);
    expect(discoverDefenders(dir, 'src/utils/permissions.ts')).toEqual(d.canDetect);
  });
});

describe('discoverDefenders — symbol-level barrels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-discover-barrel-'));
  const write = (rel, text) => { mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('src/guard.ts', 'export const allowed = () => true;\n');
  write('src/index.ts', "export { allowed } from './guard';\n");
  write('test/real.test.ts', "import { allowed } from '../src/index';\nexpect(allowed()).toBe(true);\n");
  write('test/mocked.test.ts', "import { vi, expect } from 'vitest';\nimport { allowed } from '../src/index';\nvi.mock('../src/index');\nexpect(allowed).toBeDefined();\n");
  write('src/a.ts', 'export const same = 1;\n');
  write('src/b.ts', 'export const same = 2;\n');
  write('src/ambiguous.ts', "export * from './a';\nexport * from './b';\n");
  write('test/ambiguous.test.ts', "import { same } from '../src/ambiguous';\nexpect(same).toBeDefined();\n");
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); resetAliasCache(); });

  it('follows the imported symbol and disqualifies a mock anywhere on its witnessed path', () => {
    const detail = discoverDefendersDetailed(dir, 'src/guard.ts', Object.freeze(['test/mocked.test.ts', 'test/real.test.ts']));
    expect(detail.importing).toEqual(['test/mocked.test.ts', 'test/real.test.ts']);
    expect(detail.canDetect).toEqual(['test/real.test.ts']);
    expect(detail.mocking).toEqual(['test/mocked.test.ts']);
    expect(detail.indeterminate).toEqual([]);
    expect(detail.dependencies).toEqual(['src/index.ts', 'test/mocked.test.ts', 'test/real.test.ts']);
  });

  it('keeps an ambiguous symbol origin explicit instead of turning it into nocover', () => {
    const detail = discoverDefendersDetailed(dir, 'src/a.ts', Object.freeze(['test/ambiguous.test.ts']));
    expect(detail.canDetect).toEqual([]);
    expect(detail.indeterminate).toEqual([expect.objectContaining({ file: 'test/ambiguous.test.ts', reason: 'ambiguous-resolution' })]);
  });
});
