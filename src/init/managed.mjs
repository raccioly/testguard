import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../util/hash.mjs';

/**
 * The hooks, CI files and agent instructions `testguard init` writes, and the
 * markers that let a later `init` recognize them (issue #270).
 *
 * Every block TestGuard owns carries `template=<n>` and the sha256 of its own
 * body. A block whose body still has that hash was never edited, so
 * `init --upgrade` may replace it; an edited one is reported and left alone
 * unless `--force` says otherwise. Anything outside a block is never touched.
 *
 * Pure apart from the scanner, which only reads files.
 */

/** Bump when a template's commands change in a way an existing project should pick up. */
export const TEMPLATE_VERSION = 3;

/**
 * The command the hooks and CI fall back to when the project has no install:
 * the exact version of the TestGuard writing the template, never a floating
 * tag (#293). A floating tag would hand every adopter's CI an unreviewed
 * release within the hour; an exact pin moves only through a pull request the
 * project's own CI gates (the dependency-update rule init writes).
 */
export function npxPinned(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new TypeError(`a template pins an exact version, not ${JSON.stringify(version)}`);
  return `npx -y testguard-cli@${version}`;
}

/**
 * GitHub Actions in the CI template, pinned by commit SHA with the version in
 * a comment, as this repository's own workflows pin them (a tag can be moved).
 */
export const ACTIONS = Object.freeze({
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  setupPython: 'actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0',
  cache: 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
});

const short = (text) => sha256(text).slice(0, 16);
const BEGIN_RE = /^(#|\/\/) >>> testguard managed: ([a-z0-9-]+) template=(\d+)(?: sha256=([0-9a-f]+))? >>>$/;
const END_RE = (name) => new RegExp(`^(#|//) <<< testguard managed: ${name} <<<$`);

/** A block TestGuard owns: markers around `body`, with its template number and hash. */
export function managedBlock(name, body, { comment = '#' } = {}) {
  const text = body.replace(/\n+$/, '');
  return `${comment} >>> testguard managed: ${name} template=${TEMPLATE_VERSION} sha256=${short(text)} >>>\n${text}\n${comment} <<< testguard managed: ${name} <<<`;
}

/** Every managed block in `text`: name, template, line range, and whether its body was edited. */
export function parseManagedBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN_RE.exec(lines[i]);
    if (!m) continue;
    const end = lines.findIndex((line, j) => j > i && END_RE(m[2]).test(line));
    if (end === -1) continue;
    const body = lines.slice(i + 1, end).join('\n');
    blocks.push({ name: m[2], template: Number(m[3]), start: i, end, modified: m[4] ? short(body) !== m[4] : true });
    i = end;
  }
  return blocks;
}

/** `text` with the block named `name` replaced by `block` (whole lines), or null when there is none. */
export function replaceManagedBlock(text, name, block) {
  const found = parseManagedBlocks(text).find((b) => b.name === name);
  if (!found) return null;
  const lines = text.split('\n');
  return [...lines.slice(0, found.start), block, ...lines.slice(found.end + 1)].join('\n');
}

// ── Templates ───────────────────────────────────────────────────────────────

/** The managed block's name for a project: one block per project in a shared hook file. */
export const prePushBlockName = (dir) => (dir === '.' ? 'pre-push' : `pre-push-${dir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

/**
 * The pre-push block: probe only the claims the commits being pushed can
 * affect, with automatic fault workers. An installed TestGuard only (#301):
 * the project's own install (it respects a pin), then the repository root's,
 * then a `testguard` on PATH (Homebrew). With none, it says how to install the
 * exact version that wrote the block and lets the push through: no npx fetch,
 * which fails on machines whose npm refuses fresh releases (min-release-age)
 * and would run unreviewed code from a hook. CI and the nightly job are the
 * gate. The full probe is the nightly job, never this hook. It lives in
 * the hook file the repository already uses (`.husky/pre-push`, else
 * `.githooks/pre-push`), beside anything else there.
 */
export function prePushBlock(dir = '.', { version } = {}) {
  npxPinned(version); // the same exact-version rule as every template
  const install = `npm i -D --save-exact testguard-cli@${version}, or brew install raccioly/tap/testguard`;
  return managedBlock(prePushBlockName(dir), `# TestGuard: probe only the claims the commits being pushed can affect.
# --changed auto compares against the upstream / default branch; with no base
# it probes nothing and says so (CI and the nightly job are the gate). Faults run in parallel by default, and every kill is
# confirmed by a run alone. The full probe is the nightly job: testguard probe
# Regenerated by \`testguard init --upgrade\`; edit outside this block.
(
  ROOT=$(git rev-parse --show-toplevel) && cd "$ROOT/${dir === '.' ? '' : dir}" || exit 0
  if [ -x ./node_modules/.bin/testguard ]; then set -- ./node_modules/.bin/testguard
  elif [ -x "$ROOT/node_modules/.bin/testguard" ]; then set -- "$ROOT/node_modules/.bin/testguard"
  elif command -v testguard >/dev/null 2>&1; then set -- testguard
  else echo "testguard: not installed here, so this push was not probed (CI is the gate). Install it: ${install}" >&2; exit 0
  fi
  "$@" probe --changed auto --when-no-base skip --quiet
) || exit 1`);
}

/** A whole hook file holding only TestGuard's block. */
export const prePushScript = (dir = '.', opts = {}) => `#!/bin/sh\n${prePushBlock(dir, opts)}\n`;

/** How CI installs the project's dependencies, from the lockfile beside it. */
export function installStep(projectDir) {
  const has = (f) => existsSync(join(projectDir, f));
  if (has('pnpm-lock.yaml')) return { node: true, run: 'corepack enable && pnpm install --frozen-lockfile' };
  if (has('yarn.lock')) return { node: true, run: 'corepack enable && yarn install --immutable' };
  if (has('package-lock.json')) return { node: true, run: 'npm ci' };
  if (has('package.json')) return { node: true, run: 'npm install' };
  if (has('requirements.txt')) return { python: true, run: 'pip install -r requirements.txt' };
  if (has('pyproject.toml')) return { python: true, run: 'pip install -e .' };
  return { node: true, run: 'echo "install your test dependencies here"' };
}

/**
 * The GitHub Actions workflow: a pull request probes its change, a nightly
 * (and manual) run probes every claim, and the evidence is cached between
 * runs so only what changed is measured again. One whole managed file.
 */
export function githubWorkflow({ dir = '.', install, version }) {
  const fallback = npxPinned(version);
  const cd = dir === '.' ? '' : `\n    defaults:\n      run:\n        working-directory: ${dir}`;
  const at = dir === '.' ? '' : `${dir}/`;
  const setup = install.python
    ? `      - uses: ${ACTIONS.setupPython}\n        with:\n          python-version: '3.12'\n      - uses: ${ACTIONS.setupNode}\n        with:\n          node-version: 22`
    : `      - uses: ${ACTIONS.setupNode}\n        with:\n          node-version: 22`;
  return managedBlock('github-workflow', `# TestGuard: a pull request probes the claims its change can affect; the
# nightly (and manual) run probes every claim. Evidence is cached, so only
# what changed is measured again. Faults run in parallel by default.
# It runs the project's installed TestGuard, else exactly ${version}; updates
# arrive as pull requests from the dependency-update rule init wrote.
# Regenerated by \`testguard init --upgrade --ci github\`; edit outside the markers
# or remove them to own this file.
name: TestGuard
on:
  pull_request:
  schedule:
    - cron: '23 3 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  testguard:
    runs-on: ubuntu-latest${cd}
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          fetch-depth: 0
${setup}
      - run: ${install.run}
      - name: Resolve TestGuard
        run: |
          if [ -x ./node_modules/.bin/testguard ]; then echo "TESTGUARD=./node_modules/.bin/testguard" >> "$GITHUB_ENV"
          else echo "TESTGUARD=${fallback}" >> "$GITHUB_ENV"; fi
      - uses: ${ACTIONS.cache}
        with:
          path: ${at}.testguard/evidence.json
          key: testguard-evidence-\${{ github.sha }}
          restore-keys: testguard-evidence-
      - name: Probe the change
        if: github.event_name == 'pull_request'
        run: $TESTGUARD probe --changed auto
      - name: Probe every claim
        if: github.event_name != 'pull_request'
        run: $TESTGUARD probe`);
}

/** The GitLab CI file to `include:` — same split as the GitHub workflow. */
export function gitlabCi({ dir = '.', install, version }) {
  const fallback = npxPinned(version);
  // GitLab runs before_script and script in one shell, so a relative cd
  // would apply twice; every line goes to the same absolute directory.
  const cd = dir === '.' ? '' : `cd "$CI_PROJECT_DIR/${dir}" && `;
  const at = dir === '.' ? '' : `${dir}/`;
  return managedBlock('gitlab-ci', `# TestGuard: include this file from .gitlab-ci.yml:
#   include:
#     - local: ${at}testguard.gitlab-ci.yml
# A merge request probes the claims its change can affect; a scheduled or
# manual pipeline probes every claim. Evidence is cached between pipelines.
# It runs the project's installed TestGuard, else exactly ${version}.
# Regenerated by \`testguard init --upgrade --ci gitlab\`.
.testguard:
  image: ${install.python ? 'nikolaik/python-nodejs:python3.12-nodejs22' : 'node:22'}
  variables:
    GIT_DEPTH: 0
  cache:
    key: testguard-evidence
    paths:
      - ${at}.testguard/evidence.json
  before_script:
    - ${cd}${install.run}
    - if [ -x "$CI_PROJECT_DIR/${at}node_modules/.bin/testguard" ]; then TESTGUARD="$CI_PROJECT_DIR/${at}node_modules/.bin/testguard"; else TESTGUARD="${fallback}"; fi
testguard:changed:
  extends: .testguard
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - ${cd}$TESTGUARD probe --changed auto
testguard:full:
  extends: .testguard
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule" || $CI_PIPELINE_SOURCE == "web"
  script:
    - ${cd}$TESTGUARD probe`);
}

// ── Skill marker ────────────────────────────────────────────────────────────

const SKILL_MARK_RE = /^<!-- testguard:template (\d+) sha256=([0-9a-f]+) -->\n/m;

/** The skill as init writes it: the template, with a marker after the front matter. */
export function markSkill(template) {
  const body = template.replace(SKILL_MARK_RE, '');
  const end = body.startsWith('---\n') ? body.indexOf('\n---\n', 4) + 5 : 0;
  return `${body.slice(0, end)}<!-- testguard:template ${TEMPLATE_VERSION} sha256=${short(body)} -->\n${body.slice(end)}`;
}

/**
 * What an installed skill is: `current`, `old` (an unmodified older
 * template: safe to replace), or `modified` (somebody edited it).
 */
export function skillState(installed, template, history = []) {
  const m = SKILL_MARK_RE.exec(installed);
  if (m) {
    const body = installed.replace(SKILL_MARK_RE, '');
    if (short(body) !== m[2]) return 'modified';
    return Number(m[1]) >= TEMPLATE_VERSION && installed === markSkill(template) ? 'current' : 'old';
  }
  return history.includes(sha256(installed)) ? 'old' : 'modified';
}

// ── Scanner ─────────────────────────────────────────────────────────────────

const semver = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map(Number);
/** a < b, for plain x.y.z versions; anything else is not comparable (false). */
export function olderThan(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Files where a TestGuard hook or CI job may live, relative to the git root. */
function candidateFiles(root) {
  const files = ['.husky/pre-push', '.husky/pre-commit', '.githooks/pre-push', '.pre-commit-config.yaml', '.gitlab-ci.yml', 'lefthook.yml', 'lefthook.yaml', '.claude/settings.json'];
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows)) if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
  }
  // A nested project's GitLab include, wherever init put it.
  const ls = spawnSync('git', ['ls-files', '-z', '--', '*testguard.gitlab-ci.yml'], { cwd: root, encoding: 'utf8' });
  if (ls.status === 0) files.push(...ls.stdout.split('\0').filter(Boolean));
  files.push('testguard.gitlab-ci.yml');
  // The repository's own hook directory is shared by every worktree; read, never written.
  const hooks = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' });
  if (hooks.status === 0) files.push(relative(root, join(hooks.stdout.trim(), 'pre-push')).split(sep).join('/'));
  return [...new Set(files)];
}

/**
 * Hooks and CI files that run TestGuard the slow or stale way: `--serial`,
 * a full probe on every push, a pinned version older than this one, or a
 * managed block from an older template. One finding per line, with whether
 * `init --upgrade` can fix it (only a managed block it wrote and nobody edited).
 * Reads files only: no network, no git writes.
 */
export function scanInstalled({ root, toolVersion }) {
  const findings = [];
  if (!root) return findings;
  for (const file of candidateFiles(root)) {
    const path = join(root, file);
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const blocks = parseManagedBlocks(text);
    for (const b of blocks) {
      if (b.template < TEMPLATE_VERSION) findings.push({ file, line: b.start + 1, reason: 'old-template', managed: true, upgradable: !b.modified, detail: `written by template ${b.template}; this TestGuard writes template ${TEMPLATE_VERSION}` });
    }
    const inBlock = (i) => blocks.some((b) => i >= b.start && i <= b.end);
    const lines = text.split('\n');
    const prePush = /(^|\/)pre-push$/.test(file);
    lines.forEach((line, i) => {
      if (!/testguard/i.test(line)) return;
      // A floating version is a finding wherever it is, a managed block included (#293).
      const floating = /testguard-cli@(latest|next|\*)(?![\w.-])/.exec(line) ?? /\bnpx\s+(?:-y\s+|--yes\s+)?testguard-cli(?=\s|$|['"])/.exec(line);
      if (floating) findings.push({ file, line: i + 1, reason: 'floating-version', managed: inBlock(i), upgradable: inBlock(i) && blocks.some((b) => i >= b.start && i <= b.end && !b.modified), detail: `runs ${floating[0].trim()}: a floating version, so a new release runs here unreviewed` });
      if (inBlock(i)) return;
      const at = { file, line: i + 1, managed: false, upgradable: false };
      if (/\bprobe\b/.test(line) && /--serial\b/.test(line)) findings.push({ ...at, reason: 'serial', detail: 'runs probe --serial: one fault at a time' });
      const pin = /testguard-cli@(v?\d+\.\d+\.\d+)/.exec(line);
      if (pin && olderThan(pin[1], toolVersion)) findings.push({ ...at, reason: 'pinned-old', detail: `pins testguard-cli@${pin[1]}; ${toolVersion} is installed here` });
      const action = /raccioly\/testguard@(v?\d+\.\d+\.\d+)/.exec(line);
      if (action && olderThan(action[1], toolVersion)) findings.push({ ...at, reason: 'pinned-old', detail: `uses the action at ${action[1]}; ${toolVersion} is installed here` });
      if (prePush && /\bprobe\b/.test(line) && !/--changed\b/.test(line) && !/--claim\b/.test(line)) findings.push({ ...at, reason: 'full-probe-on-push', detail: 'probes every claim on every push' });
    });
    // pre-commit: a `rev:` under the TestGuard repo.
    if (file === '.pre-commit-config.yaml') {
      lines.forEach((line, i) => {
        if (!/repo:\s*\S*testguard/.test(line)) return;
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const rev = /^\s*rev:\s*['"]?(v?\d+\.\d+\.\d+)/.exec(lines[j]);
          if (rev && olderThan(rev[1], toolVersion)) findings.push({ file, line: j + 1, reason: 'pinned-old', managed: false, upgradable: false, detail: `pins the pre-commit hooks at ${rev[1]}; ${toolVersion} is installed here` });
        }
      });
    }
  }
  return findings;
}

/** One line for a finding, with what fixes it. */
export function renderFinding(f) {
  const fix = f.upgradable ? 'testguard init --upgrade rewrites it'
    : f.managed ? 'edited by hand, so init --upgrade leaves it: merge the current template, or pass --force'
      : f.reason === 'serial' ? 'drop --serial (faults now run in parallel safely)'
        : f.reason === 'pinned-old' ? 'raise the pin, or let Dependabot/Renovate do it'
          : f.reason === 'floating-version' ? 'pin an exact version (testguard-cli@<x.y.z>) or run the project install, and let Dependabot/Renovate raise it'
          : 'use probe --changed auto here and keep the full probe for the nightly job';
  return `${f.file}:${f.line}: ${f.detail} — ${fix}`;
}
