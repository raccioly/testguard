// The PyPI package is a wrapper (testguard_cli/wrapper.py) that runs the npm
// package. With no project-local install it falls back to npx; that fallback
// must run the CLI version the wheel was released with, never `@latest`.
// Run under `python3 -I -S` (no user or site packages), with the package
// metadata supplied by a dist-info directory the test writes, and a stub
// `npx` on PATH that records its argv.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pyproject = readFileSync(join(ROOT, 'pyproject.toml'), 'utf8');
const pyVersion = /^version = "([^"]+)"/m.exec(pyproject)[1];

let dir;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-pywrap-')));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'site'));
  mkdirSync(join(dir, 'cwd'));
  writeFileSync(join(dir, 'bin', 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'npx-args')}"\n`);
  chmodSync(join(dir, 'bin', 'npx'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Install metadata for testguard-cli <version> where importlib.metadata finds it. */
function installedAs(version) {
  const info = join(dir, 'site', `testguard_cli-${version}.dist-info`);
  mkdirSync(info);
  writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.1\nName: testguard-cli\nVersion: ${version}\n`);
}

function wrapper(...args) {
  const code = `import sys; sys.path[:0] = [${JSON.stringify(join(dir, 'site'))}, ${JSON.stringify(ROOT)}]; sys.argv = ['testguard', *sys.argv[1:]]; from testguard_cli.wrapper import main; main()`;
  const r = spawnSync('python3', ['-I', '-S', '-c', code, ...args], {
    cwd: join(dir, 'cwd'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  const npx = existsSync(join(dir, 'npx-args')) ? readFileSync(join(dir, 'npx-args'), 'utf8').trimEnd().split('\n') : undefined;
  return { status: r.status, stderr: r.stderr, npx };
}

describe('testguard_cli/wrapper.py — the npx fallback', () => {
  it('pyproject.toml is at the npm package version (the release sync keeps them together)', () => {
    expect(pyVersion).toBe(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  });

  it('runs testguard-cli pinned to the installed wheel\'s own version, never @latest', () => {
    installedAs('9.8.7');
    const r = wrapper('probe', '--quiet');
    expect(r.status, r.stderr).toBe(0);
    expect(r.npx).toEqual(['-y', 'testguard-cli@9.8.7', 'probe', '--quiet']);
  });

  it('with the release version installed, the fallback names exactly that version', () => {
    installedAs(pyVersion);
    expect(wrapper('status').npx).toEqual(['-y', `testguard-cli@${pyVersion}`, 'status']);
  });

  it('refuses rather than run an unpinned CLI when it cannot read its own version', () => {
    const r = wrapper('probe');
    expect(r.status).toBe(1);
    expect(r.npx).toBeUndefined();
    expect(r.stderr).toMatch(/cannot determine the installed testguard-cli version/);
  });

  it('a project-local node_modules/testguard-cli still wins over npx', () => {
    installedAs('9.8.7');
    const cli = join(dir, 'cwd', 'node_modules', 'testguard-cli', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'testguard.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'local-ran'))}, process.argv.slice(2).join(' '));\n`);
    const r = wrapper('claims');
    expect(r.status, r.stderr).toBe(0);
    expect(r.npx).toBeUndefined();
    expect(readFileSync(join(dir, 'local-ran'), 'utf8')).toBe('claims');
  });
});
