import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDiscoveryManifest } from '../src/probe/runners/discovery.mjs';
import { hashNativeTestUniverse, readNativeTestUniverse } from '../src/probe/universe.mjs';
import { sha256 } from '../src/util/hash.mjs';

const entry = (name, options = {}) => [{ name }, createDiscoveryManifest({ runner: name, version: '1.0', files: ['test/a.test.mjs'], ...options })];
it('preserves the existing aggregate preimage, independent of manifest collection order', () => {
  const entries = [entry('vitest'), entry('python')];
  const expected = sha256(JSON.stringify([{ runner: 'python', hash: entries[1][1].testUniverseHash }, { runner: 'vitest', hash: entries[0][1].testUniverseHash }]));
  expect(hashNativeTestUniverse(new Map(entries))).toBe(expected);
  expect(hashNativeTestUniverse(new Map([...entries].reverse()))).toBe(expected);
});
it.each([{ version: '2.0' }, { files: ['test/a.test.mjs', 'test/new.test.mjs'] }, { files: ['test/other.test.mjs'] }, { configFiles: [{ path: 'vitest.config.mjs', sha256: 'a'.repeat(64) }] }, { source: 'adapter' }])('binds version, configured membership, config and discovery source: %j', (change) => {
  expect(hashNativeTestUniverse(new Map([entry('vitest', change)]))).not.toBe(hashNativeTestUniverse(new Map([entry('vitest')])));
});
it('binds every owning runner and refuses missing, duplicate or edited manifests', () => {
  expect(hashNativeTestUniverse(new Map([entry('vitest'), entry('python')]))).not.toBe(hashNativeTestUniverse(new Map([entry('vitest')])));
  expect(() => hashNativeTestUniverse(new Map())).toThrow();
  expect(() => hashNativeTestUniverse([entry('vitest', { files: [] })])).toThrow();
  expect(() => hashNativeTestUniverse([entry('vitest'), entry('vitest')])).toThrow();
  const changed = entry('vitest'); changed[1].files.push('test/new.test.mjs');
  expect(() => hashNativeTestUniverse([changed])).toThrow(/inconsistent/);
  const renamed = entry('vitest'); renamed[0].name = 'jest';
  expect(() => hashNativeTestUniverse([renamed])).toThrow(/inconsistent/);
});
it('uses real current native configured membership and catches added tests/configuration edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-native-current-'));
  mkdirSync(join(dir, 'checks'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['checks/**/*.case.mjs'] } };\n");
  writeFileSync(join(dir, 'checks/a.case.mjs'), "import { it } from 'vitest'; it('a', () => {});\n");
  const options = { projectDir: dir, sourceDir: dir, runnerName: 'vitest', budgetMs: 15000 };
  try {
    const first = await readNativeTestUniverse(options);
    expect(first.manifests.get(first.primary).files).toEqual(['checks/a.case.mjs']);
    expect((await readNativeTestUniverse(options)).testUniverseHash).toBe(first.testUniverseHash);
    writeFileSync(join(dir, 'checks/b.case.mjs'), "import { it } from 'vitest'; it('b', () => {});\n");
    const added = await readNativeTestUniverse(options);
    expect(added.testUniverseHash).not.toBe(first.testUniverseHash);
    expect(added.manifests.get(added.primary).files).toEqual(['checks/a.case.mjs', 'checks/b.case.mjs']);
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['checks/a.case.mjs'] } };\n");
    const config = await readNativeTestUniverse(options);
    expect(config.testUniverseHash).not.toBe(first.testUniverseHash);
    expect(config.manifests.get(config.primary).files).toEqual(['checks/a.case.mjs']);
    writeFileSync(join(dir, 'vitest.config.mjs'), 'export default { broken: ;\n');
    await expect(readNativeTestUniverse(options)).rejects.toThrow(/discovery/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
