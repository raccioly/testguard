import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDefenders } from '../src/probe/discover.mjs';

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
