import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blastRadius, loadAliases } from '../src/probe/rank.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-alias-'));
  mkdirSync(join(dir, 'src', 'lib', 'api'), { recursive: true });
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  // tsconfig with comments + trailing comma + extends
  writeFileSync(join(dir, 'tsconfig.base.json'), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@api": ["src/lib/api/middleware.ts"], } } }');
  writeFileSync(join(dir, 'tsconfig.json'), '{\n  // project config\n  "extends": "./tsconfig.base",\n  "compilerOptions": { "strict": true, },\n}');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', imports: { '#lib/*': './src/lib/*', '#cond': { import: './src/lib/api/middleware.ts' } } }));
  writeFileSync(join(dir, 'src', 'lib', 'api', 'middleware.ts'), 'export const m = 1;\n');
  writeFileSync(join(dir, 'src', 'app', 'a.ts'), "import { m } from '@/lib/api/middleware';\n");
  writeFileSync(join(dir, 'src', 'app', 'b.ts'), "import { m } from '@api';\n");
  writeFileSync(join(dir, 'src', 'app', 'c.ts'), "import { m } from '#lib/api/middleware';\n");
  writeFileSync(join(dir, 'src', 'app', 'd.ts'), "import { m } from '#cond';\n");
  writeFileSync(join(dir, 'src', 'app', 'e.ts'), "import { m } from '../lib/api/middleware';\n");
  writeFileSync(join(dir, 'src', 'app', 'f.ts'), "import { m } from 'some-package';\n");
  writeFileSync(join(dir, 'src', 'app', 'g.test.ts'), "import { m } from '@/lib/api/middleware';\n");
  return dir;
}

describe('blastRadius with path aliases', () => {
  const dir = project();
  it('loads tsconfig paths (through extends, with comments) and package.json imports', () => {
    const rules = loadAliases(dir);
    expect(rules.map((r) => r.prefix).sort()).toEqual(['#cond', '#lib/', '@/', '@api']);
  });
  it('counts aliased, conditional-import and relative importers; ignores bare specifiers and test files', () => {
    expect(blastRadius(dir, 'src/lib/api/middleware.ts')).toBe(5);
  });
});
