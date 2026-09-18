#!/usr/bin/env node
/**
 * package.json is the single source of truth for the version. Every other
 * surface that carries it is synced from there:
 *   - pyproject.toml         `version = "x.y.z"`
 *   - action.yml             default of the `version` input
 *   - packaging/homebrew/*.rb the tarball URL; the `sha256` is set by `--sha256`
 *                            from the PUBLISHED tarball (release.yml, after npm)
 *   - packaging/gitlab/*.yml  the include URL tag and the `version` input default
 *   - README.md               the GitHub Action reference AND the GitLab include URL
 *
 * A file may carry more than one form, and each needs its own entry: README
 * holds both the `raccioly/testguard@vX.Y.Z` action reference and the
 * `testguard/vX.Y.Z/packaging` template URL. Only the first was listed, so
 * v0.6.0 shipped with both README copies of the GitLab URL left at v0.5.0
 * while `--check` reported "all version surfaces at 0.6.0" — a surface this
 * script was never told to look at cannot drift in its eyes.
 *
 * The Homebrew `sha256` is the same lesson one step further: the URL was a
 * surface, the hash beside it was a comment telling a human to run curl. It
 * carried 385d69f9… unchanged across v0.6.0, v0.7.0 and v0.8.0 — a hash
 * matching none of them. So the hash is now a surface too, with three modes:
 *
 *   --check            offline: every version surface at package.json's version,
 *                      the formula's sha256 is 64 hex and not the known-stale
 *                      placeholder. Used by release.yml's test job (before the
 *                      tag, when the tarball cannot exist yet) and prepublishOnly.
 *   --check --online   additionally downloads the tarball the formula names and
 *                      requires its sha256 to match. Used by release.yml's
 *                      detect-version (is the formula still owed?) and by the
 *                      sha job as a post-condition before it opens the PR.
 *   --sha256           waits for the tarball to become downloadable (bounded by
 *                      --wait), computes its sha256 and writes it into the
 *                      formula — only when the value changes. Exit 1 on timeout
 *                      or on a 200 that is not a gzip tarball: a hashed error
 *                      page would poison the formula, and "never optimistic".
 *
 * The hash is always computed from the REGISTRY tarball — what Homebrew will
 * download — never from a local `npm pack`: a provenance-signed publish can
 * differ byte for byte from the pack output.
 *
 *   --registry <url>   registry base (default https://registry.npmjs.org); the
 *                      tests point it at a local server so `npm test` is offline.
 *   --wait <s>         how long --sha256 keeps polling (default 900).
 *   --interval <s>     seconds between polls (default 15).
 *   --timeout <s>      per-request timeout (default 60): a registry that accepts the
 *                      connection and never answers is a failed attempt, not a hang.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[1], '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const check = flag('--check');
const online = flag('--online');
const setSha = flag('--sha256');
const registry = (option('--registry', 'https://registry.npmjs.org')).replace(/\/+$/, '');
const waitSeconds = Number(option('--wait', '900'));
const intervalSeconds = Number(option('--interval', '15'));
const timeoutSeconds = Number(option('--timeout', '60'));
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error(`--wait must be a non-negative number of seconds, got ${option('--wait')}`);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) throw new Error(`--interval must be a non-negative number of seconds, got ${option('--interval')}`);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(`--timeout must be a positive number of seconds, got ${option('--timeout')}`);

const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version is not a stable semver: ${version}`);

const FORMULA = 'packaging/homebrew/testguard.rb';
const formulaPath = resolve(root, FORMULA);
/** The hash the formula carried, unchanged, from v0.6.0 through v0.8.0. It matches no published tarball. */
const KNOWN_STALE_SHA256 = '385d69f9d3c153b934d9c1cb6a2c754eb9b221b0a8c0ba8b805858384d2d4678';
const SHA_LINE = /^(\s*sha256 ")([^"]*)(")/m;
const TARBALL = `testguard-cli-${version}.tgz`;
const tarballUrl = `${registry}/testguard-cli/-/${TARBALL}`;

const surfaces = [
  ['pyproject.toml', /^version = "[^"]+"/m, `version = "${version}"`],
  ['action.yml', /(\n  version:\n    description: [^\n]*\n    required: false\n    default: ')[^']*(')/, `$1${version}$2`],
  [FORMULA, /testguard-cli-\d+\.\d+\.\d+\.tgz/g, TARBALL],
  ['README.md', /raccioly\/testguard@v\d+\.\d+\.\d+/g, `raccioly/testguard@v${version}`],
  ['README.md', /testguard\/v\d+\.\d+\.\d+\/packaging/g, `testguard/v${version}/packaging`],
  ['packaging/gitlab/testguard.gitlab-ci.yml', /testguard\/v\d+\.\d+\.\d+\/packaging/g, `testguard/v${version}/packaging`],
  ['packaging/gitlab/testguard.gitlab-ci.yml', /(\n    version:\n      description: [^\n]*\n      default: ")\d+\.\d+\.\d+(")/, `$1${version}$2`],
];

/** The formula's current `sha256 "…"` value, or a throw when the line is missing. */
function formulaSha256() {
  const m = SHA_LINE.exec(readFileSync(formulaPath, 'utf8'));
  if (!m) throw new Error(`${FORMULA}: sha256 line not found`);
  return m[2];
}

/**
 * One GET of the tarball. Returns `{ status, sha256 }`; `sha256` is set only
 * for a 200 whose body starts with the gzip magic (1f 8b) — a registry error
 * page with a 200 status is treated as "not a tarball", never hashed.
 */
async function fetchTarball() {
  const res = await fetch(tarballUrl, { redirect: 'follow', signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  if (res.status !== 200) return { status: res.status };
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return { status: 200, notTarball: true, bytes: body.length };
  return { status: 200, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/**
 * Polls until the tarball downloads as a gzip, or the wait runs out. Every
 * non-200 and every network error counts as "not yet": the registry answers
 * `PUT 202` to a publish and can take minutes to serve the file.
 */
async function waitForTarball() {
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt = 0;
  for (;;) {
    attempt++;
    let result;
    try {
      result = await fetchTarball();
    } catch (e) {
      result = { status: 0, error: e.message };
    }
    if (result.sha256) return result;
    const why = result.notTarball ? `200 but not a gzip tarball (${result.bytes} bytes)` : result.error ? `network error: ${result.error}` : `HTTP ${result.status}`;
    if (Date.now() >= deadline) throw new Error(`${tarballUrl}: not downloadable after ${attempt} attempt(s) over ${waitSeconds}s — last: ${why}`);
    console.error(`${TARBALL}: ${why}; retrying in ${intervalSeconds}s (attempt ${attempt})`);
    await sleep(intervalSeconds);
  }
}

if (setSha) {
  const { sha256, bytes } = await waitForTarball();
  const before = readFileSync(formulaPath, 'utf8');
  const current = formulaSha256();
  if (current === sha256) {
    console.log(`${FORMULA}: sha256 unchanged (${sha256}, ${bytes} bytes)`);
  } else {
    writeFileSync(formulaPath, before.replace(SHA_LINE, `$1${sha256}$3`));
    if (formulaSha256() !== sha256) throw new Error(`${FORMULA}: sha256 line did not take the new value`);
    console.log(`${FORMULA}: sha256 ${current} -> ${sha256} (${bytes} bytes from ${tarballUrl})`);
  }
  process.exit(0);
}

let drift = 0;
for (const [rel, pattern, replacement] of surfaces) {
  const path = resolve(root, rel);
  const before = readFileSync(path, 'utf8');
  if (!pattern.test(before)) throw new Error(`${rel}: version pattern not found`);
  const after = before.replace(pattern, replacement);
  if (after === before) continue;
  drift++;
  if (check) console.error(`${rel}: out of sync with package.json ${version}`);
  else { writeFileSync(path, after); console.log(`${rel}: synced to ${version}`); }
}

if (check) {
  const sha = formulaSha256();
  if (!/^[0-9a-f]{64}$/.test(sha)) { drift++; console.error(`${FORMULA}: sha256 is not 64 hex characters: "${sha}"`); }
  else if (sha === KNOWN_STALE_SHA256) { drift++; console.error(`${FORMULA}: sha256 is the known-stale placeholder ${sha.slice(0, 8)}… (matches no published tarball); run --sha256 after publishing`); }
  if (online) {
    let result;
    try {
      result = await fetchTarball();
    } catch (e) {
      result = { status: 0, error: e.message };
    }
    if (!result.sha256) { drift++; console.error(`${FORMULA}: tarball not downloadable — ${tarballUrl}: ${result.error ?? (result.notTarball ? '200 but not a gzip tarball' : `HTTP ${result.status}`)}`); }
    else if (result.sha256 !== sha) { drift++; console.error(`${FORMULA}: sha256 ${sha} does not match the published tarball ${result.sha256} (${tarballUrl})`); }
    else console.log(`${FORMULA}: sha256 matches ${tarballUrl}`);
  }
}
if (check && drift) process.exit(1);
if (check) console.log(`all version surfaces at ${version}`);
