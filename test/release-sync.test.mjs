import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['package.json', 'pyproject.toml', 'action.yml', 'README.md', 'packaging/homebrew/testguard.rb', 'packaging/gitlab/testguard.gitlab-ci.yml'];

/** A copy of every version surface plus the script, so the real repository is never rewritten. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-release-sync-'));
  for (const rel of SURFACES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  cpSync(join(ROOT, '.github', 'scripts', 'sync-release-version.mjs'), join(dir, '.github', 'scripts', 'sync-release-version.mjs'));
  const run = (...args) => spawnSync('node', [join(dir, '.github', 'scripts', 'sync-release-version.mjs'), ...args], { encoding: 'utf8' });
  const bump = (version) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.version = version;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  };
  return { dir, run, bump };
}

describe('sync-release-version: package.json is the single source of truth for the version', () => {
  it('--check exits 1 and names every surface that drifted; a sync writes them all; --check then exits 0', () => {
    const { dir, run, bump } = sandbox();
    expect(run('--check').status).toBe(0); // the checkout itself is in sync
    bump('9.8.7');
    const drift = run('--check');
    expect(drift.status).toBe(1);
    for (const rel of SURFACES.slice(1)) expect(drift.stderr).toContain(`${rel}: out of sync with package.json 9.8.7`);

    const sync = run();
    expect(sync.status).toBe(0);
    expect(readFileSync(join(dir, 'pyproject.toml'), 'utf8')).toMatch(/^version = "9\.8\.7"/m);
    expect(readFileSync(join(dir, 'action.yml'), 'utf8')).toMatch(/default: '9\.8\.7'/);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('raccioly/testguard@v9.8.7');
    expect(readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8')).toContain('testguard-cli-9.8.7.tgz');
    const gitlab = readFileSync(join(dir, 'packaging/gitlab/testguard.gitlab-ci.yml'), 'utf8');
    expect(gitlab).toContain('testguard/v9.8.7/packaging');
    expect(gitlab).toMatch(/\n    version:\n      description: [^\n]*\n      default: "9\.8\.7"/);
    expect(run('--check').status).toBe(0);
  });

  it('refuses a non-stable version, so a pre-release never reaches the surfaces', () => {
    const { run, bump } = sandbox();
    bump('1.0.0-rc.1');
    const r = run('--check');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a stable semver/);
  });
});
