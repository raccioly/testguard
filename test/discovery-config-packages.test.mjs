// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// Config dependency hashing on the layouts real projects have: a vitest config
// that imports `vite` (#278), package installs that are plain, hoisted, nested
// or pnpm's symlinked store, workspace packages linked into node_modules, and
// configuration reached through symbolic links inside the repository (#199).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashDiscoveryConfigs, MAX_DISCOVERY_CONFIG_BYTES } from '../src/probe/runners/discovery.mjs';

const dirs = [];
const scratch = (prefix = 'testguard-config-pkg-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const link = (root, rel, target) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(target, join(root, rel));
};
const VITEST_CONFIG = ['vitest.config.mjs', 'vite.config.mjs'];
const moduleEntries = (entries) => entries.filter((entry) => entry.path.startsWith('@module/'));
// A package whose module file is larger than every project-file cap, as
// `vite` is: its bundled chunks are several MiB.
const hugePackage = (root, dir, name, version) => {
  write(root, `${dir}/package.json`, JSON.stringify({ name, version, type: 'module', exports: { '.': { import: './dist/index.mjs', require: './dist/index.mjs' } } }));
  write(root, `${dir}/dist/index.mjs`, `export const mergeConfig = (a, b) => ({ ...a, ...b });\n/*${'x'.repeat(MAX_DISCOVERY_CONFIG_BYTES + 1)}*/\n`);
};

describe('a bare package import is recorded by name and version, never read (#278)', () => {
  it('hashes a config that imports vite, whose module files exceed every file cap', () => {
    const dir = scratch();
    write(dir, 'package.json', '{"type":"module"}');
    write(dir, 'vitest.config.mjs', "import { mergeConfig, defineConfig } from 'vite';\nimport base from './vite.config.mjs';\nexport default mergeConfig(base, defineConfig({ test: {} }));\n");
    write(dir, 'vite.config.mjs', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
    hugePackage(dir, 'node_modules/vite', 'vite', '7.1.0');

    const entries = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    expect(entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(['vitest.config.mjs', 'vite.config.mjs']));
    expect(moduleEntries(entries)).toHaveLength(2);
  });

  it('changes the hash with the resolved version and ignores the package module bytes', () => {
    const dir = scratch();
    write(dir, 'vitest.config.mjs', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
    write(dir, 'node_modules/vite/package.json', '{"name":"vite","version":"7.1.0","main":"index.js"}');
    write(dir, 'node_modules/vite/index.js', 'module.exports = {};\n');
    const before = moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG));
    write(dir, 'node_modules/vite/index.js', 'module.exports = { changed: true };\n');
    expect(moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG))).toEqual(before);
    write(dir, 'node_modules/vite/package.json', '{"name":"vite","version":"7.1.1","main":"index.js"}');
    expect(moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG))).not.toEqual(before);
  });

  it('finds ESM-only packages, deep subpaths, nested installs and a dist/package.json without a name', () => {
    const dir = scratch();
    write(dir, 'vitest.config.mjs', "import { defineConfig } from 'vitest/config';\nimport plugin from '@scope/plugin/sub/path';\nexport default defineConfig({ plugins: [plugin()] });\n");
    // vitest: ESM-only exports (no `require` condition), which require.resolve cannot find.
    write(dir, 'node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version: '5.0.0', type: 'module', exports: { './config': { import: './dist/config.js' } } }));
    write(dir, 'node_modules/vitest/dist/package.json', '{"type":"module"}');
    write(dir, 'node_modules/vitest/dist/config.js', 'export const defineConfig = (c) => c;\n');
    hugePackage(dir, 'node_modules/@scope/plugin', '@scope/plugin', '1.2.3');
    expect(moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG))).toHaveLength(2);

    // A nested config resolves its own nearest install first, as Node does.
    write(dir, 'packages/app/vitest.config.mjs', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n");
    write(dir, 'packages/app/node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version: '4.1.0' }));
    write(dir, 'vitest.config.mjs', "import nested from './packages/app/vitest.config.mjs';\nexport default nested;\n");
    const nested = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    write(dir, 'packages/app/node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version: '4.1.1' }));
    expect(moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG))).not.toEqual(moduleEntries(nested));
  });

  it("follows pnpm's symlinked store and a scratch tree whose node_modules links outside it", () => {
    const install = scratch('testguard-config-install-');
    const dir = scratch();
    hugePackage(install, '.pnpm/vite@7.1.0/node_modules/vite', 'vite', '7.1.0');
    link(install, 'vite', join(install, '.pnpm/vite@7.1.0/node_modules/vite'));
    // The probe's scratch worktree: node_modules is one link to the source checkout's install.
    symlinkSync(install, join(dir, 'node_modules'));
    write(dir, 'vitest.config.mjs', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
    expect(moduleEntries(hashDiscoveryConfigs(dir, VITEST_CONFIG))).toHaveLength(1);
  });

  it('follows a workspace package linked into node_modules like a relative import', () => {
    const dir = scratch();
    write(dir, 'package.json', '{"type":"module","workspaces":["packages/*"]}');
    write(dir, 'packages/test-config/package.json', '{"name":"@acme/test-config","version":"0.0.0","type":"module","exports":{".":{"import":"./index.mjs"}}}');
    write(dir, 'packages/test-config/index.mjs', "import { setup } from './setup.mjs';\nexport default { test: { setup } };\n");
    write(dir, 'packages/test-config/setup.mjs', 'export const setup = 1;\n');
    link(dir, 'node_modules/@acme/test-config', '../../packages/test-config');
    write(dir, 'vitest.config.mjs', "import shared from '@acme/test-config';\nexport default shared;\n");

    const before = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    expect(before.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'packages/test-config/index.mjs', 'packages/test-config/setup.mjs',
    ]));
    write(dir, 'packages/test-config/setup.mjs', 'export const setup = 2;\n');
    const after = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    expect(after.find((entry) => entry.path === 'packages/test-config/setup.mjs').sha256)
      .not.toBe(before.find((entry) => entry.path === 'packages/test-config/setup.mjs').sha256);
  });

  it('keeps the size cap for project files and says which file, which limit and what to do', () => {
    const dir = scratch();
    write(dir, 'vitest.config.mjs', "import data from './fixtures/big.mjs';\nexport default data;\n");
    write(dir, 'fixtures/big.mjs', `export default {};\n/*${'x'.repeat(256)}*/\n`);
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG, { maxConfigBytes: 128 }))
      .toThrow(/fixtures\/big\.mjs exceeded 128 bytes.*(import it from the tests|split the module)/i);
  });

  it('ignores a string literal longer than any path, such as a description in a Vite config', () => {
    const dir = scratch();
    const description = `A long product description, ${'with many words and no path in it, '.repeat(12)}which no file system can name.`;
    write(dir, 'vite.config.mjs', `export default { define: { DESCRIPTION: ${JSON.stringify(description)} } };\n`);
    expect(hashDiscoveryConfigs(dir, VITEST_CONFIG).map((entry) => entry.path)).toContain('vite.config.mjs');
  });

  it('hashes, without scanning, a large data file a configuration names, such as a claims file or a lockfile', () => {
    const dir = scratch();
    const big = (fill) => JSON.stringify({ claims: [], padding: fill.repeat(MAX_DISCOVERY_CONFIG_BYTES + 1) });
    write(dir, 'claims.data.json', big('a'));
    write(dir, 'package-lock.json', big('l'));
    write(dir, 'vite.config.mjs', "export const DEV_ONLY = ['claims.data.json'];\nexport default {};\n");
    const before = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    expect(before.map((entry) => entry.path)).toEqual(expect.arrayContaining(['claims.data.json', 'package-lock.json']));
    write(dir, 'claims.data.json', big('b'));
    write(dir, 'package-lock.json', big('m'));
    const after = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    for (const path of ['claims.data.json', 'package-lock.json']) {
      expect(after.find((entry) => entry.path === path).sha256).not.toBe(before.find((entry) => entry.path === path).sha256);
    }
    // The hashing bound still holds, by name.
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG, { maxHashBytes: MAX_DISCOVERY_CONFIG_BYTES + 2 })).toThrow(/(claims\.data|package-lock)\.json exceeded \d+ bytes/);
  });

  it('still refuses a bare import that resolves nowhere', () => {
    const dir = scratch();
    write(dir, 'vitest.config.mjs', "import config from 'missing-test-config';\nexport default config;\n");
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/imports unresolved module missing-test-config/i);
  });
});

describe('symbolic links inside the repository are followed (#199)', () => {
  it('reads a symlinked root config and a config under a symlinked directory', () => {
    const dir = scratch();
    write(dir, 'configs/vitest.mjs', "import setup from './setup.mjs';\nexport default { test: { setup } };\n");
    write(dir, 'configs/setup.mjs', 'export default 1;\n');
    link(dir, 'vitest.config.mjs', 'configs/vitest.mjs');
    link(dir, 'shared', 'configs');
    write(dir, 'vite.config.mjs', "import extra from './shared/setup.mjs';\nexport default extra;\n");

    const before = hashDiscoveryConfigs(dir, VITEST_CONFIG);
    expect(before.map((entry) => entry.path)).toEqual(expect.arrayContaining(['vitest.config.mjs', 'vite.config.mjs', 'configs/setup.mjs']));
    write(dir, 'configs/setup.mjs', 'export default 2;\n');
    expect(hashDiscoveryConfigs(dir, VITEST_CONFIG)).not.toEqual(before);
  });

  it('follows a referenced in-repository link, such as a committed documentation link', () => {
    const dir = scratch();
    write(dir, 'docs/constitution.md', '# rules\n');
    link(dir, '.specify/memory/constitution.md', '../../docs/constitution.md');
    write(dir, 'vitest.config.mjs', "export default { test: { include: ['.specify/memory/constitution.md'] } };\n");
    expect(hashDiscoveryConfigs(dir, VITEST_CONFIG).map((entry) => entry.path)).toContain('.specify/memory/constitution.md');
  });

  it('refuses, naming the path, a link whose real path leaves the repository', () => {
    const dir = scratch();
    const outside = scratch('testguard-config-outside-');
    write(outside, 'setup.mjs', 'export default 1;\n');
    link(dir, 'escape.mjs', join(outside, 'setup.mjs'));
    write(dir, 'vitest.config.mjs', "import setup from './escape.mjs';\nexport default setup;\n");
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/escape\.mjs.*outside the project/);

    // Through a linked directory: the last component is a plain file.
    link(dir, 'cfg', outside);
    write(dir, 'vitest.config.mjs', "import setup from './cfg/setup.mjs';\nexport default setup;\n");
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/cfg\/setup\.mjs.*outside the project/);

    // A root candidate that is itself a link out of the project.
    rmSync(join(dir, 'vitest.config.mjs'));
    link(dir, 'vitest.config.mjs', join(outside, 'setup.mjs'));
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/vitest\.config\.mjs.*outside the project/);
  });

  it('refuses a dangling link out of the project and a link cycle, naming the path', () => {
    const dir = scratch();
    const outside = scratch('testguard-config-outside-');
    link(dir, 'gone.mjs', join(outside, 'missing.mjs'));
    write(dir, 'vitest.config.mjs', "export default { test: { setupFiles: ['./gone.mjs'] } };\n");
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/gone\.mjs.*outside the project/);

    rmSync(join(dir, 'gone.mjs'));
    link(dir, 'loop-a.mjs', 'loop-b.mjs');
    link(dir, 'loop-b.mjs', 'loop-a.mjs');
    write(dir, 'vitest.config.mjs', "import x from './loop-a.mjs';\nexport default x;\n");
    expect(() => hashDiscoveryConfigs(dir, VITEST_CONFIG)).toThrow(/loop-a\.mjs is a symbolic link cycle/);
  });
});
