#!/usr/bin/env node
/**
 * package.json is the single source of truth for the version. Every other
 * surface that carries it is synced from there:
 *   - pyproject.toml         `version = "x.y.z"`
 *   - action.yml             default of the `version` input
 *   - packaging/homebrew/*.rb the tarball URL (sha256 is set after publish)
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
 * `--check` verifies instead of writing (used by release.yml).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[1], '..', '..', '..');
const check = process.argv.includes('--check');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version is not a stable semver: ${version}`);

const surfaces = [
  ['pyproject.toml', /^version = "[^"]+"/m, `version = "${version}"`],
  ['action.yml', /(\n  version:\n    description: [^\n]*\n    required: false\n    default: ')[^']*(')/, `$1${version}$2`],
  ['packaging/homebrew/testguard.rb', /testguard-cli-\d+\.\d+\.\d+\.tgz/g, `testguard-cli-${version}.tgz`],
  ['README.md', /raccioly\/testguard@v\d+\.\d+\.\d+/g, `raccioly/testguard@v${version}`],
  ['README.md', /testguard\/v\d+\.\d+\.\d+\/packaging/g, `testguard/v${version}/packaging`],
  ['packaging/gitlab/testguard.gitlab-ci.yml', /testguard\/v\d+\.\d+\.\d+\/packaging/g, `testguard/v${version}/packaging`],
  ['packaging/gitlab/testguard.gitlab-ci.yml', /(\n    version:\n      description: [^\n]*\n      default: ")\d+\.\d+\.\d+(")/, `$1${version}$2`],
];

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
if (check && drift) process.exit(1);
if (check) console.log(`all version surfaces at ${version}`);
