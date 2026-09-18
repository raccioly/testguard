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
  it('returns the test files that import the target, by relative path or alias, and nothing else', () => {
    expect(discoverDefenders(dir, 'src/lib/guard.ts')).toEqual(['test/alias.test.ts', 'test/guard.test.ts']);
    expect(discoverDefenders(dir, 'src/lib/other.ts')).toEqual(['test/other.test.ts']);
    expect(discoverDefenders(dir, 'src/lib/nothing.ts')).toEqual([]);
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
