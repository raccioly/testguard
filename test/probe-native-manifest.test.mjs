import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const claim = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 's', source: { kind: 'manual' }, severity: 'low', producedBy: { producer: 'human' },
  faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/a.mjs', find: '1', replace: '2', producedBy: { producer: 'human' } }] }] };

const repository = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  return { dir, git };
};

describe('dirty preflight native discovery manifests', () => {
  it('refuses a dirty config-defined defender even when its name is outside legacy test globs', async () => {
    const { dir, git } = repository('tg-precond-configured-');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'checks'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
    writeFileSync(join(dir, 'checks', 'a.case.mjs'), "import { a } from '../src/a.mjs';\nvoid a;\n");
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['checks/**/*.case.mjs'] } };\n");
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    git('add', '-A'); git('commit', '-qm', 'configured test');
    writeFileSync(join(dir, 'checks', 'a.case.mjs'), "import { a } from '../src/a.mjs';\nvoid a;\n// dirty configured defender\n");
    await expect(probe({ projectDir: dir, claims: claim, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(/checks\/a\.case\.mjs/);
  }, 60_000);

  it('refuses a dirty imported config helper and fails closed when dirty-tree discovery cannot load it', async () => {
    const { dir, git } = repository('tg-precond-config-helper-');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
    writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs';\nvoid a;\n");
    writeFileSync(join(dir, 'vitest.config.mjs'), "import config from './vitest.helper.mjs';\nexport default config;\n");
    writeFileSync(join(dir, 'vitest.helper.mjs'), 'export default { test: {} };\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    git('add', '-A'); git('commit', '-qm', 'configured test');

    writeFileSync(join(dir, 'vitest.helper.mjs'), 'export default { test: { passWithNoTests: true } };\n');
    await expect(probe({ projectDir: dir, claims: claim, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(/vitest\.helper\.mjs/);

    writeFileSync(join(dir, 'vitest.helper.mjs'), "throw new Error('dirty helper failed');\n");
    await expect(probe({ projectDir: dir, claims: claim, mode: 'worktree', toolVersion: 't' }))
      .rejects.toThrow(/cannot verify dirty defender\/config inputs.*test discovery failed/i);
  }, 60_000);

  it('resolves a custom Playwright defender relative to testDir in the owned-runner manifest', async () => {
    const { dir, git } = repository('tg-precond-owned-manifest-');
    for (const path of ['src', 'unit', 'e2e', 'node_modules/@playwright']) mkdirSync(join(dir, path), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', 'vitest'), join(dir, 'node_modules', 'vitest'), 'dir');
    const playwrightPackage = join(dir, 'node_modules', '@playwright', 'test');
    mkdirSync(playwrightPackage, { recursive: true });
    writeFileSync(join(playwrightPackage, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.0.0-test', type: 'module', bin: { playwright: './cli.mjs' } }));
    writeFileSync(join(playwrightPackage, 'cli.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ errors: [], suites: [{ file: 'a.pw.ts', specs: [], suites: [] }] }));",
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module","devDependencies":{"vitest":"*","@playwright/test":"*"}}');
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = () => 1;\n');
    writeFileSync(join(dir, 'unit', 'a.test.mjs'), "import { it } from 'vitest';\nit('unit', () => {});\n");
    writeFileSync(join(dir, 'e2e', 'a.pw.ts'), "import { test } from '@playwright/test';\ntest('browser', async () => {});\n");
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['unit/**/*.test.mjs'] } };\n");
    writeFileSync(join(dir, 'playwright.config.mjs'), "export default { testDir: './e2e', testMatch: '*.pw.ts' };\n");
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    git('add', '-A'); git('commit', '-qm', 'mixed configured tests');
    writeFileSync(join(dir, 'e2e', 'a.pw.ts'), "import { test } from '@playwright/test';\ntest('browser', async () => {});\n// dirty owned defender\n");
    await expect(probe({ projectDir: dir, claims: claim, mode: 'worktree', toolVersion: 't' })).rejects.toThrow(/e2e\/a\.pw\.ts/);
  }, 60_000);
});
