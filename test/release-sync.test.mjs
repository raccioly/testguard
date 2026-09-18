import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

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

/**
 * The Homebrew formula's `sha256` is a release surface like the URL beside it.
 * It carried 385d69f9… unchanged across v0.6.0, v0.7.0 and v0.8.0 while the
 * URL was bumped each time — the formula header told a human to run curl, and
 * nobody did. These tests drive the script's `--sha256` and `--check --online`
 * modes against a LOCAL registry so the suite never touches the network, and
 * so the registry can misbehave on purpose: 404 while npm is still processing
 * the publish, a 200 that is an error page, a hash that does not match.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const PLACEHOLDER = '385d69f9d3c153b934d9c1cb6a2c754eb9b221b0a8c0ba8b805858384d2d4678';
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');
const formulaSha = (dir) => /^\s*sha256 "([^"]*)"/m.exec(readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8'))[1];
const setFormulaSha = (dir, sha) => {
  const p = join(dir, 'packaging/homebrew/testguard.rb');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^(\s*sha256 ")[^"]*(")/m, `$1${sha}$2`));
};

/**
 * The script, spawned WITHOUT blocking the worker: the registry below lives on
 * this event loop, and `spawnSync` would freeze it while the child waits for a
 * response that can then never come.
 */
const runAsync = (dir, ...args) => new Promise((resolve) => {
  const child = spawn('node', [join(dir, '.github', 'scripts', 'sync-release-version.mjs'), ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/** A registry that answers each request from `responses` in order, repeating the last one. Records every path it was asked for. */
async function registry(responses) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    const r = responses[Math.min(paths.length - 1, responses.length - 1)];
    res.writeHead(r.status, { 'content-type': r.type ?? 'application/octet-stream' });
    res.end(r.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, paths, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('sync-release-version: the Homebrew sha256 is a release surface, computed from the published tarball', () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tarball = gzipSync(Buffer.from(`testguard-cli ${version} as npm serves it`));
  const ok = { status: 200, body: tarball };
  const fast = ['--interval', '0.01', '--wait', '5'];

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

  it('--sha256 waits through 404s while npm processes the publish, then writes the hash of the bytes the registry served — and only writes when it changes', async () => {
    const reg = await registry([{ status: 404 }, { status: 404 }, ok]);
    try {
      const { dir, run } = sandbox();
      setFormulaSha(dir, PLACEHOLDER);
      const first = await runAsync(dir, '--sha256', '--registry', reg.url, ...fast);
      expect(first.status, first.stderr).toBe(0);
      expect(reg.paths.length).toBeGreaterThanOrEqual(3);
      expect(new Set(reg.paths)).toEqual(new Set([`/testguard-cli/-/testguard-cli-${version}.tgz`])); // what Homebrew downloads
      expect(formulaSha(dir)).toBe(sha256Of(tarball));
      expect(first.stdout).toContain(`sha256 ${PLACEHOLDER} -> ${sha256Of(tarball)}`);

      const before = readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8');
      const again = await runAsync(dir, '--sha256', '--registry', reg.url, ...fast);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('sha256 unchanged');
      expect(readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8')).toBe(before);
      expect(run('--check').status).toBe(0);
    } finally {
      await reg.close();
    }
  });

  it('--sha256 gives up after --wait and leaves the formula alone when the tarball never appears', async () => {
    const reg = await registry([{ status: 404 }]);
    try {
      const { dir, run } = sandbox();
      const r = await runAsync(dir, '--sha256', '--registry', reg.url, '--interval', '0.01', '--wait', '0.2');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/not downloadable after \d+ attempt\(s\) over 0\.2s — last: HTTP 404/);
      // How many attempts fit in 0.2s is a wall-clock question; that it retries at all is
      // pinned by the 404-404-200 test above, which cannot pass without a third request.
      expect(reg.paths.length).toBeGreaterThanOrEqual(1);
      expect(formulaSha(dir)).not.toBe(PLACEHOLDER); // untouched: still the checkout's value
      expect(formulaSha(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await reg.close();
    }
  });

  it('--sha256 never hashes a 200 that is not a gzip tarball (a registry error page would poison the formula)', async () => {
    const reg = await registry([{ status: 200, type: 'text/html', body: '<html>Service Unavailable</html>' }]);
    try {
      const { dir, run } = sandbox();
      const original = formulaSha(dir);
      const r = await runAsync(dir, '--sha256', '--registry', reg.url, '--interval', '0.01', '--wait', '0.05');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/200 but not a gzip tarball/);
      expect(formulaSha(dir)).toBe(original);
    } finally {
      await reg.close();
    }
  });

  it('--check --online passes only when the formula hash matches the downloadable tarball; a mismatch or a missing tarball is drift', async () => {
    const reg = await registry([ok]);
    const gone = await registry([{ status: 404 }]);
    try {
      const { dir, run } = sandbox();
      setFormulaSha(dir, sha256Of(tarball));
      const match = await runAsync(dir, '--check', '--online', '--registry', reg.url);
      expect(match.status, match.stderr).toBe(0);
      expect(match.stdout).toMatch(/sha256 matches http:\/\/127\.0\.0\.1:\d+\/testguard-cli\/-\/testguard-cli-/);

      setFormulaSha(dir, 'a'.repeat(64));
      const mismatch = await runAsync(dir, '--check', '--online', '--registry', reg.url);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toMatch(new RegExp(`sha256 ${'a'.repeat(64)} does not match the published tarball ${sha256Of(tarball)}`));
      expect(run('--check').status).toBe(0); // offline, the same formula is structurally fine: the mismatch is only visible online

      setFormulaSha(dir, sha256Of(tarball));
      const missing = await runAsync(dir, '--check', '--online', '--registry', gone.url);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/tarball not downloadable — .*: HTTP 404/);
    } finally {
      await reg.close();
      await gone.close();
    }
  });
});

/**
 * The release workflows must allow exactly the files a release writes.
 *
 * This is the bug that stopped every weekly release: the GitLab template was
 * added to the sync script's surface table on 2026-09-17 and to neither of the
 * two hand-written allow-lists, so `scheduled-release.yml` would have rejected
 * the release for writing a file the release exists to write, and
 * `auto-merge.yml` would have held the PR for human review. Nobody saw it
 * because the workflow already failed one step earlier.
 *
 * `scheduled-release.yml` now derives its list from `--list-surfaces`, so it
 * cannot drift. `auto-merge.yml` spells it out on purpose — it is the gate
 * that merges without review — so THIS test is what keeps it honest.
 */
describe('sync-release-version: the release workflows allow exactly what a release writes', () => {
  /** What the bump step writes directly, beside the synced surfaces. */
  const BUMP_WRITES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
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
