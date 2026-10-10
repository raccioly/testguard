import { expect, it } from 'vitest';
import { createDiscoveryManifest } from '../src/probe/runners/discovery.mjs';
import { hashNativeTestUniverse } from '../src/probe/universe.mjs';
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

it('binds a custom command universe to the command as well as the files', async () => {
  const { hashCustomCommandUniverse } = await import('../src/probe/universe.mjs');
  const { parseCommandTemplate } = await import('../src/probe/runners/shared.mjs');
  const files = ['test/a.test.mjs'];
  const fixed = hashCustomCommandUniverse(files, parseCommandTemplate('node runner.cjs {files} {out}'));
  // A broken command fixed in place is a different measurement: the files did not change, the command did.
  expect(fixed).not.toBe(hashCustomCommandUniverse(files, parseCommandTemplate('node runnr.cjs {files} {out}')));
  expect(fixed).not.toBe(hashCustomCommandUniverse(['test/a.test.mjs', 'test/b.test.mjs'], parseCommandTemplate('node runner.cjs {files} {out}')));
  // Whitespace that parses to the same argv is the same command.
  expect(fixed).toBe(hashCustomCommandUniverse(files, parseCommandTemplate('node   runner.cjs {files}  {out}')));
  expect(fixed).toMatch(/^[0-9a-f]{64}$/);
});
