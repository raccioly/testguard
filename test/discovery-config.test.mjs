// @req FR-10
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryError, createDiscoveryManifest, hashDiscoveryConfigs, normalizeDiscoveredFiles } from '../src/probe/runners/discovery.mjs';

const dirs = [];
const scratch = (prefix = 'testguard-config-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

  it('ignores routes, URL bases, and separators in an imported Vite config while hashing real helpers', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'vitest.config.mjs'), "import config from './vite.config.mjs'; export default config;\n");
    writeFileSync(join(dir, 'vite.config.mjs'), "export default { base: '/', plugins: [{ configureServer(s) { s.middlewares.use('/__rooms', () => {}); const parts = '/__room'.split('/'); } }], test: { setupFiles: ['./setup.mjs'] } };\n");
    writeFileSync(join(dir, 'setup.mjs'), 'globalThis.ready = true;\n');
    const before = hashDiscoveryConfigs(dir, ['vitest.config.mjs']);
    expect(before.map((entry) => entry.path)).toEqual(expect.arrayContaining(['vite.config.mjs', 'setup.mjs']));
    writeFileSync(join(dir, 'setup.mjs'), 'globalThis.ready = false;\n');
    expect(hashDiscoveryConfigs(dir, ['vitest.config.mjs']).find((entry) => entry.path === 'setup.mjs').sha256)
      .not.toBe(before.find((entry) => entry.path === 'setup.mjs').sha256);
  });

  it('still refuses outside-project files and symlinks, including dangling dependencies', () => {
    const dir = scratch();
    const outside = scratch('testguard-outside-config-');
    const external = join(outside, 'setup.mjs');
    writeFileSync(external, 'globalThis.ready = true;\n');
    for (const reference of [external, `${outside}/setup`]) {
      writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { setupFiles: [${JSON.stringify(reference)}] } };\n`);
      expect(() => hashDiscoveryConfigs(dir, ['vitest.config.mjs'])).toThrow(/outside the project/);
    }
    const link = join(dir, 'linked.mjs');
    symlinkSync(join(outside, 'missing.mjs'), link);
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { setupFiles: ['./linked.mjs'] } };\n");
    expect(() => hashDiscoveryConfigs(dir, ['vitest.config.mjs'])).toThrow(/symbolic links/);
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

