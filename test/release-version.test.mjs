import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {ROOT,SURFACES,sandbox,PLACEHOLDER,formulaSha,setFormulaSha} from './helpers/release-project.mjs';
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
const HISTORICAL = new Set(['CHANGELOG.md', 'package-lock.json', 'test/release-sync.test.mjs', 'test/release-version.test.mjs', 'test/release-tap.test.mjs']);

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

describe('formula structural admission',()=>{
  it('--check refuses the known-stale placeholder and a value that is not 64 hex', () => {
    const { dir, run } = sandbox();
    setFormulaSha(dir, PLACEHOLDER);
    const stale = run('--check');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/packaging\/homebrew\/testguard\.rb: sha256 is the known-stale placeholder 385d69f9/);

    setFormulaSha(dir, 'deadbeef');
    const junk = run('--check');
    expect(junk.status).toBe(1);
    expect(junk.stderr).toMatch(/sha256 is not 64 hex characters: "deadbeef"/);
  });

});

describe('sync-release-version: the release workflows allow exactly what a release writes', () => {
  /** What the bump step writes directly, beside the synced surfaces. */
  // docs/testguard-explained.pdf is not a surface — it is RENDERED from one,
  // by build-one-pager.mjs in the same release step — but the release commits
  // it, so every allow-list has to admit it or the PR is held for a file the
  // release itself wrote.
  const BUMP_WRITES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'docs/testguard-explained.pdf'];
  const listed = () => {
    const r = spawnSync('node', [join(ROOT, '.github', 'scripts', 'sync-release-version.mjs'), '--list-surfaces'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split('\n').filter(Boolean);
  };

  it('--list-surfaces names every file a real sync writes, and nothing it does not', () => {
    const { dir, run, bump } = sandbox();
    bump('9.8.7');
    expect(run().status).toBe(0);
    // Which files did the sync actually change? Compare the sandbox to the repo.
    const written = SURFACES.slice(1).filter((rel) => readFileSync(join(dir, rel), 'utf8') !== readFileSync(join(ROOT, rel), 'utf8'));
    expect(written.length).toBeGreaterThan(0);
    for (const rel of written) expect(listed()).toContain(rel);
    // And the reverse: nothing is listed that a sync leaves untouched.
    for (const rel of listed()) expect(written).toContain(rel);
  });

  it('auto-merge.yml allows every release surface, so a release PR is never held for a file the release must write', () => {
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'auto-merge.yml'), 'utf8');
    const m = /const RELEASE_SURFACES = new Set\(\[([^\]]*)\]\)/.exec(text);
    expect(m, 'RELEASE_SURFACES not found in auto-merge.yml').toBeTruthy();
    const allowed = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    const missing = [...listed(), ...BUMP_WRITES].filter((rel) => !allowed.has(rel));
    expect(missing, `auto-merge.yml would hold a release PR that touches: ${missing.join(', ')}`).toEqual([]);
  });

  it('scheduled-release.yml derives its allow-list from the script instead of repeating it', () => {
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'scheduled-release.yml'), 'utf8');
    expect(text).toContain('--list-surfaces');
    // A retyped `case` list is exactly what drifted; it must not come back.
    expect(text).not.toMatch(/case "\$f" in package\.json\|/);
  });
});
