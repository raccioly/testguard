// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// Vitest `test.projects` (#277), end to end against the installed vitest:
// native discovery keeps each file's projects, and a defender runs under each
// project that lists it, selected with --project.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vitest from '../src/probe/runners/vitest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const scratch = (prefix = 'testguard-vitest-projects-run-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('vitest projects against the installed vitest', () => {
  // The discriminator: a file of ANOTHER project whose path contains the
  // defender's path. Without --project vitest runs it too, and its failure
  // would read as the defender failing.
  const projectsLayout = (dir) => {
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    write(dir, 'package.json', JSON.stringify({ type: 'module' }));
    write(dir, 'vitest.config.mjs', `export default { test: { projects: [
  { test: { name: 'ui', env: { WHICH: 'ui' }, include: ['tests/ui/**/*.test.mjs', 'tests/shared/**/*.test.mjs'] } },
  { test: { name: 'node', env: { WHICH: 'node' }, include: ['tests/shared/**/*.test.mjs'] } },
  { test: { name: 'legacy', include: ['legacy/**/*.test.mjs'] } },
] } };
`);
    write(dir, 'tests/ui/a.test.mjs', "import { it, expect } from 'vitest';\nit('ui', () => expect(process.env.WHICH).toBe('ui'));\n");
    write(dir, 'tests/shared/both.test.mjs', "import { it, expect } from 'vitest';\nit('both', () => expect(['ui', 'node']).toContain(process.env.WHICH));\n");
    write(dir, 'legacy/tests/ui/a.test.mjs', "import { it, expect } from 'vitest';\nit('legacy', () => expect(1).toBe(2));\n");
  };

  it('discovers the membership natively and runs each defender only where it is configured', async () => {
    const dir = scratch();
    projectsLayout(dir);
    const manifest = await vitest.discoverTests({ projectDir: dir, version: '5.0.0', timeoutMs: 60_000 });
    expect(manifest.files).toEqual(['legacy/tests/ui/a.test.mjs', 'tests/shared/both.test.mjs', 'tests/ui/a.test.mjs']);
    expect(manifest.projects).toEqual({
      'legacy/tests/ui/a.test.mjs': ['legacy'],
      'tests/shared/both.test.mjs': ['node', 'ui'],
      'tests/ui/a.test.mjs': ['ui'],
    });

    const ui = await vitest.run({ projectDir: dir, files: ['tests/ui/a.test.mjs'], projects: manifest.projects, budgetMs: 60_000 });
    expect(ui.run.outcome).toBe('pass');
    expect(ui.run.tests.total).toBe(1);
    const both = await vitest.run({ projectDir: dir, files: ['tests/shared/both.test.mjs'], projects: manifest.projects, budgetMs: 60_000 });
    expect(both.run).toMatchObject({ outcome: 'pass', tests: { total: 2, passed: 2 } });
  }, 120_000);

  it('merges a file listed under two projects pessimistically: a failure in either is a failure', async () => {
    const dir = scratch();
    projectsLayout(dir);
    write(dir, 'tests/shared/both.test.mjs', "import { it, expect } from 'vitest';\nit('both', () => expect(process.env.WHICH).toBe('ui'));\n");
    const manifest = await vitest.discoverTests({ projectDir: dir, version: '5.0.0', timeoutMs: 60_000 });
    const both = await vitest.run({ projectDir: dir, files: ['tests/shared/both.test.mjs'], projects: manifest.projects, budgetMs: 60_000 });
    expect(both.run).toMatchObject({ outcome: 'fail', tests: { total: 2, passed: 1, failed: 1 } });
  }, 120_000);
});
