// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DiscoveryError,
  createDiscoveryManifest,
  hashDiscoveryConfigs,
  normalizeDiscoveredFiles,
  readBoundedJsonFile,
  runDiscoveryProcess,
} from '../src/probe/runners/discovery.mjs';
import * as jest from '../src/probe/runners/jest.mjs';
import * as playwright from '../src/probe/runners/playwright.mjs';
import * as vitest from '../src/probe/runners/vitest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const scratch = (prefix = 'testguard-discovery-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const waitForFile = async (path, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path);
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the native discovery process boundary', () => {
  it('captures successful output but rejects non-zero exits, timeouts and oversized output', async () => {
    const ok = await runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
    });
    expect(ok.stdout).toBe('ok');

    await expect(runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', 'console.error("bad config"); process.exit(2)'],
    })).rejects.toThrow(/exited 2.*bad config/i);
    await expect(runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    })).rejects.toThrow(/50ms.*exceeded/i);
    const descendant = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr] })`;
    await expect(runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', descendant],
      timeoutMs: 50,
    })).rejects.toThrow(/50ms.*exceeded/i);
    if (process.platform !== 'win32') {
      const dir = scratch('testguard-discovery-tree-');
      const marker = join(dir, 'survived');
      const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 350)`;
      const detached = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`;
      await expect(runDiscoveryProcess({
        projectDir: dir,
        argv: [process.execPath, '-e', detached],
        timeoutMs: 100,
      })).rejects.toThrow(/100ms.*exceeded/i);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(marker)).toBe(false);

      const orphanMarker = join(dir, 'orphan-survived');
      const orphan = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'alive'), 450)`;
      const helper = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(orphan)}], { detached: true, stdio: 'ignore' }).unref()`;
      const daemonizer = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`;
      await expect(runDiscoveryProcess({
        projectDir: dir,
        argv: [process.execPath, '-e', daemonizer],
        timeoutMs: 150,
      })).rejects.toThrow(/cleanup-unverified.*reparented daemon/i);
      expect(await waitForFile(orphanMarker)).toBe(true);
    }
    await expect(runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(100))'],
      maxOutputBytes: 32,
    })).rejects.toThrow(/output.*32 bytes/i);
    await expect(runDiscoveryProcess({
      projectDir: ROOT,
      argv: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0xff]))'],
    })).rejects.toThrow(/UTF-8/i);
  });

  it('bounds and validates file-based JSON reports before parsing them', () => {
    const dir = scratch();
    const report = join(dir, 'report.json');
    writeFileSync(report, '{"suites":[]}');
    expect(readBoundedJsonFile(report, 32)).toEqual({ suites: [] });
    expect(() => readBoundedJsonFile(report, 4)).toThrow(/exceeded 4 bytes/i);
    writeFileSync(report, '{nope');
    expect(() => readBoundedJsonFile(report, 32)).toThrow(/not valid JSON/i);
    writeFileSync(report, Buffer.from([0xff]));
    expect(() => readBoundedJsonFile(report, 32)).toThrow(/UTF-8/i);
  });
});

describe('normalization and the deterministic discovery manifest', () => {
  it('returns sorted, unique, project-relative POSIX file names and a stable hash', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'z.test.mjs'), '');
    writeFileSync(join(dir, 'test', 'a.test.mjs'), '');
    const files = normalizeDiscoveredFiles(dir, [
      join(dir, 'test', 'z.test.mjs'),
      'test/a.test.mjs',
      'test/a.test.mjs',
    ]);
    expect(files).toEqual(['test/a.test.mjs', 'test/z.test.mjs']);
    const a = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files });
    const b = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files: [...files].reverse() });
    expect(a).toEqual(b);
    expect(a.testUniverseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files: [files[0]] }).testUniverseHash)
      .not.toBe(a.testUniverseHash);
  });

  it('binds the manifest hash to bounded conventional config dependencies', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['test/**'] } };\n");
    const beforeConfig = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    const before = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files: [], configFiles: beforeConfig });
    const reorderedKeys = createDiscoveryManifest({
      runner: 'vitest',
      version: '5.0.0',
      files: [],
      configFiles: [...beforeConfig].reverse().map((entry) => ({ sha256: entry.sha256, ignored: true, path: entry.path })),
    });
    expect(reorderedKeys).toEqual(before);
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['test/**'], sequence: { concurrent: false } } };\n");
    const afterConfig = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    const after = createDiscoveryManifest({ runner: 'vitest', version: '5.0.0', files: [], configFiles: afterConfig });
    expect(before.configFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'package.json' }),
      expect.objectContaining({ path: 'vitest.config.mjs' }),
    ]));
    expect(after.testUniverseHash).not.toBe(before.testUniverseHash);
    writeFileSync(join(dir, 'package.json'), 'x'.repeat(33));
    expect(() => hashDiscoveryConfigs(dir, ['vitest.config.mjs'], { maxConfigBytes: 32 })).toThrow(/package\.json.*32 bytes/i);
    rmSync(join(dir, 'package.json'));
    symlinkSync(join(dir, 'vitest.config.mjs'), join(dir, 'package.json'));
    expect(() => hashDiscoveryConfigs(dir, ['vitest.config.mjs'])).toThrow(/package\.json.*not readable/i);
  });

  it('invalidates absent root configs and follows imported helpers and setup files', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'vitest.config.mjs'), "import options from './test/options.mjs';\nexport default options;\n");
    writeFileSync(join(dir, 'test', 'options.mjs'), "export default { test: { setupFiles: ['./test/setup.mjs'] } };\n");
    writeFileSync(join(dir, 'test', 'setup.mjs'), 'globalThis.ready = true;\n');

    const initial = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(initial.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'vitest.config.mjs', 'test/options.mjs', 'test/setup.mjs', 'tsconfig.json',
    ]));
    const absentTsconfig = initial.find((entry) => entry.path === 'tsconfig.json').sha256;

    writeFileSync(join(dir, 'test', 'setup.mjs'), 'globalThis.ready = false;\n');
    const setupChanged = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(setupChanged.find((entry) => entry.path === 'test/setup.mjs').sha256)
      .not.toBe(initial.find((entry) => entry.path === 'test/setup.mjs').sha256);

    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}');
    const configCreated = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(configCreated.find((entry) => entry.path === 'tsconfig.json').sha256).not.toBe(absentTsconfig);
  });

  it('includes nested workspace configs even when the root config does not import them', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
    mkdirSync(join(dir, 'tools', 'cli'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"workspaces":["packages/*"]}');
    writeFileSync(join(dir, 'vitest.workspace.mjs'), "export default ['tools/*'];\n");
    writeFileSync(join(dir, 'packages', 'app', 'package.json'), '{"name":"app"}');
    writeFileSync(join(dir, 'packages', 'app', 'vitest.config.mjs'), 'export default {};\n');
    writeFileSync(join(dir, 'tools', 'cli', 'package.json'), '{"name":"cli"}');
    writeFileSync(join(dir, 'tools', 'cli', 'vitest.config.mjs'), 'export default {};\n');

    const configFiles = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(configFiles.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'packages/app/package.json',
      'packages/app/vitest.config.mjs',
      'tools/cli/package.json',
      'tools/cli/vitest.config.mjs',
    ]));
  });

  it('binds package-imported config helpers and fails closed when one cannot resolve', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'node_modules', '@scope', 'test-config'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'vitest.config.mjs'), "import config from '@scope/test-config';\nexport default config;\n");
    writeFileSync(join(dir, 'node_modules', '@scope', 'test-config', 'package.json'), '{"name":"@scope/test-config","exports":"./index.mjs"}');
    writeFileSync(join(dir, 'node_modules', '@scope', 'test-config', 'index.mjs'), "export { default } from './helper.mjs';\n");
    writeFileSync(join(dir, 'node_modules', '@scope', 'test-config', 'helper.mjs'), 'export default { test: {} };\n');

    const before = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    const moduleEntry = before.find((entry) => entry.path.startsWith('@module/'));
    expect(moduleEntry).toBeDefined();
    writeFileSync(join(dir, 'node_modules', '@scope', 'test-config', 'helper.mjs'), 'export default { test: { passWithNoTests: true } };\n');
    const after = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(after.find((entry) => entry.path === moduleEntry.path).sha256).not.toBe(moduleEntry.sha256);

    writeFileSync(join(dir, 'vitest.config.mjs'), "import config from 'missing-test-config';\nexport default config;\n");
    expect(() => hashDiscoveryConfigs(dir, ['vitest.config.mjs'])).toThrow(/imports unresolved module missing-test-config/i);
  });

  it('includes root and nested Python collection hooks in Python manifests', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'tests', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'conftest.py'), 'ROOT = True\n');
    writeFileSync(join(dir, 'tests', 'nested', 'conftest.py'), 'NESTED = True\n');
    const configFiles = hashDiscoveryConfigs(dir, ['pyproject.toml', 'conftest.py']);
    expect(configFiles.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'conftest.py',
      'tests/nested/conftest.py',
    ]));
  });

  it('rejects malformed, missing, non-file, lexical escapes and symlink escapes', () => {
    const dir = scratch();
    const outside = scratch('testguard-discovery-outside-');
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'ok.test.mjs'), '');
    writeFileSync(join(outside, 'escaped.test.mjs'), '');
    symlinkSync(join(outside, 'escaped.test.mjs'), join(dir, 'test', 'link.test.mjs'));

    expect(() => normalizeDiscoveredFiles(dir, [42])).toThrow(DiscoveryError);
    expect(() => normalizeDiscoveredFiles(dir, ['missing.test.mjs'])).toThrow(/does not exist/i);
    expect(() => normalizeDiscoveredFiles(dir, ['test'])).toThrow(/not a file/i);
    expect(() => normalizeDiscoveredFiles(dir, [join(outside, 'escaped.test.mjs')])).toThrow(/outside/i);
    expect(() => normalizeDiscoveredFiles(dir, ['test/link.test.mjs'])).toThrow(/outside/i);
  });
});

describe('runner-specific native listing adapters', () => {
  it('uses runner-native commands and parses only their documented shapes', () => {
    expect(vitest.discoveryArgvFor(ROOT).slice(-3)).toEqual(['list', '--filesOnly', '--passWithNoTests']);
    expect(jest.discoveryArgvFor(ROOT).slice(-3)).toEqual(['--listTests', '--json', '--runInBand']);
    expect(playwright.discoveryArgvFor(ROOT).slice(-3)).toEqual(['test', '--list', '--reporter=json']);

    expect(vitest.parseDiscoveryOutput('/p/b.test.mjs\n/p/a.test.mjs\n')).toEqual(['/p/b.test.mjs', '/p/a.test.mjs']);
    expect(jest.parseDiscoveryOutput('["/p/a.test.js"]')).toEqual(['/p/a.test.js']);
    expect(() => jest.parseDiscoveryOutput('{"files":[]}')).toThrow(/array/i);
    expect(playwright.parseDiscoveryReport({
      suites: [{ file: '/p/a.spec.ts', suites: [{ file: '/p/b.spec.ts', specs: [] }], specs: [] }],
      errors: [],
    })).toEqual(['/p/a.spec.ts', '/p/b.spec.ts']);
    expect(() => playwright.parseDiscoveryReport({ suites: [], errors: [{ message: 'config exploded' }] }))
      .toThrow(/config exploded/i);
  });

  it('lets Vitest load arbitrary project config instead of reimplementing its include rules', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'checks'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['checks/**/*.case.mjs'] } };\n");
    writeFileSync(join(dir, 'checks', 'visible.case.mjs'), "import { it } from 'vitest'; it('works', () => {});\n");
    writeFileSync(join(dir, 'checks', 'ignored.test.mjs'), "import { it } from 'vitest'; it('ignored', () => {});\n");

    const manifest = await vitest.discoverTests({ projectDir: dir, version: '5.0.0', timeoutMs: 30_000 });
    expect(manifest.files).toEqual(['checks/visible.case.mjs']);
    expect(manifest.runner).toEqual({ name: 'vitest', version: '5.0.0' });
  }, 60_000);

  it('lets Jest load arbitrary project config instead of reimplementing its match rules', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'checks'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'jest.config.mjs'), "export default { testMatch: ['<rootDir>/checks/**/*.case.js'] };\n");
    writeFileSync(join(dir, 'checks', 'visible.case.js'), "test('works', () => {});\n");
    writeFileSync(join(dir, 'checks', 'ignored.test.js'), "test('ignored', () => {});\n");

    const manifest = await jest.discoverTests({ projectDir: dir, version: '30.5.0', timeoutMs: 30_000 });
    expect(manifest.files).toEqual(['checks/visible.case.js']);
    expect(manifest.runner).toEqual({ name: 'jest', version: '30.5.0' });
  }, 60_000);
});
