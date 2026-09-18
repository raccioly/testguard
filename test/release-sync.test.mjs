import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['package.json', 'pyproject.toml', 'action.yml', 'README.md', 'packaging/homebrew/testguard.rb', 'packaging/gitlab/testguard.gitlab-ci.yml'];

/**
 * Every textual form that pins a PUBLISHED release of this project, with the
 * version captured.
 *
 * Derived from content, deliberately not from the script's `surfaces` list:
 * a test that read that list could only ever confirm the script agrees with
 * itself. The bug this guards against is a surface that exists in a file and
 * is not in the list at all — which is silent, because the script only
 * verifies what it was told to look at.
 */
const PINS = [
  /raccioly\/testguard@v(\d+\.\d+\.\d+)/g,       // GitHub Action reference
  /testguard\/v(\d+\.\d+\.\d+)\/packaging/g,     // raw.githubusercontent template URL
  /testguard-cli-(\d+\.\d+\.\d+)\.tgz/g,          // npm tarball (homebrew)
];

/**
 * Files where a version string names a RELEASE rather than history or a
 * fixture. CHANGELOG records past versions on purpose; the lockfile pins
 * dependencies; this file carries deliberate 9.8.7 fixtures.
 */
const HISTORICAL = new Set(['CHANGELOG.md', 'package-lock.json', 'test/release-sync.test.mjs']);

/** Every `[file, version]` pin found under `dir`, for the given relative paths. */
function pinsIn(dir, files) {
  const found = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    for (const re of PINS) for (const m of text.matchAll(re)) found.push([rel, m[1]]);
  }
  return found;
}

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

  /**
   * The bug this pins is not a stale string. It is that `--check` reported
   * success about a surface it had never been told to look at: README.md
   * carries the GitLab include URL twice, the script matched that pattern only
   * inside the GitLab template, and v0.6.0 shipped with both README copies
   * left at v0.5.0 while the check printed "all version surfaces at 0.6.0".
   */
  it('after a sync, NO pinned reference anywhere still carries the old version — including one the surfaces list forgot', () => {
    const { dir, run, bump } = sandbox();
    bump('9.8.7');
    expect(run().status).toBe(0);
    const stale = pinsIn(dir, SURFACES).filter(([, v]) => v !== '9.8.7');
    expect(stale).toEqual([]);
  });

  it('every release pin in the working tree is at the current version', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout
      .split('\n').filter(Boolean).filter((f) => !HISTORICAL.has(f));
    const stale = pinsIn(ROOT, tracked).filter(([, v]) => v !== version);
    expect(stale).toEqual([]);
  });

  it('refuses a non-stable version, so a pre-release never reaches the surfaces', () => {
    const { run, bump } = sandbox();
    bump('1.0.0-rc.1');
    const r = run('--check');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a stable semver/);
  });
});
