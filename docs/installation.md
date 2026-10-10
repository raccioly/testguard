# Installation

This page lists every way to install TestGuard, what each channel needs, how
to tell which install answered a command, and how to remove everything
`testguard init` wrote. Read it once when you pick a channel; the
[quickstart](quickstart.md) assumes the npm devDependency.

TestGuard is a Node.js CLI published to npm as `testguard-cli`. Every other
channel (pip, Homebrew, the GitHub Action, pre-commit, GitLab CI) ends up
running that same npm package.

## Requirements

| You need | When | Why |
|---|---|---|
| Node.js ≥ 20 | always | The CLI is JavaScript (`"engines": { "node": ">=20.0.0" }`). The pip wrapper refuses to start without it. |
| `git` | always | `probe` builds a scratch git worktree from a commit, and `gate` diffs against a base reference. |
| Python ≥ 3.8 | only when probing Python, or when installing through pip | The Python runner asks for "Python 3.8+" when it finds no usable interpreter; the pip package declares `requires-python = ">=3.8"`. |
| The project's own test runner | when you probe | vitest, jest and Playwright are resolved from the project's own `node_modules`; Python runs under pytest when the interpreter can import it, otherwise stdlib `unittest`. See [languages and runners](reference/languages-and-runners.md). |

TestGuard has one exact-pinned runtime dependency, `ajv` (`8.20.0`). `ajv`
brings four small packages of its own (`fast-deep-equal`, `fast-uri`,
`json-schema-traverse`, `require-from-string`), so a production install is six
packages in total.

## Pick a channel

| How | Command | Good for |
|---|---|---|
| npx (no install) | `npx testguard-cli probe` | trying it once |
| npm devDependency | `npm i -D testguard-cli` then `npx testguard probe` | a JavaScript or TypeScript project: version pinned in the lockfile, and the local install the agent layer prefers |
| pip | `pip install testguard-cli` then `testguard probe` | a Python team that does not want to touch npm directly (still needs Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` | a machine-wide `testguard` on `PATH` |
| GitHub Action | `uses: raccioly/testguard@v0.18.3` | CI on GitHub |
| pre-commit | `repo: https://github.com/raccioly/testguard` with a release tag as `rev:` ([below](#pre-commit)) | local hooks on commit and push |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.18.3/packaging/gitlab/testguard.gitlab-ci.yml` | CI on GitLab |

### npx

```bash
npx testguard-cli status        # runs the package without adding it to package.json
npx testguard-cli@<version> probe  # pin an exact version
```

npx asks the npm registry for the package when the project does not already
have it installed, so it needs network access the first time. Inside a project
that has `testguard-cli` as a dependency, `npx testguard-cli` runs that local
copy.

### npm devDependency (recommended for JavaScript projects)

```bash
npm i -D testguard-cli          # adds it to devDependencies and the lockfile
npx testguard --version         # the bin is called `testguard`
```

The package's executable is `testguard`, so after a local install both
`npx testguard` and `npx testguard-cli` work. This is the channel the
session-start hook written by `init` looks for first
(`node_modules/.bin/testguard`), which is why it is the recommended one for a
project an AI agent works in. See [AI agents](guides/ai-agents.md).

#### `min-release-age` and `ENOVERSIONS`

A project that sets `min-release-age` in `.npmrc` cannot see a version
published fewer than that many days ago, and npm fails with `ENOVERSIONS`.
Install that one version with the setting overridden on the command line:

```bash
npm i -D testguard-cli --min-release-age=0
```

### pip

```bash
pip install testguard-cli       # installs a `testguard` command (a Python wrapper)
testguard --version
```

The PyPI package does not contain the CLI. It installs a small wrapper
(`testguard_cli/wrapper.py`) that finds Node and runs the npm package:

1. It looks for `node`, then `node22`, then `node20` on `PATH` and uses the
   first whose major version is 20 or higher. With none, it exits 1 with
   `Error: Node.js 20+ is required but not found.`
2. It searches upward from the current directory for
   `node_modules/testguard-cli/cli/testguard.mjs`. If it finds one, it runs
   that file, so a project that pins `testguard-cli` in npm runs the pinned
   version offline.
3. Otherwise it runs `npx -y testguard-cli@<version>`, where `<version>` is
   the pip package's own version, read from its installed metadata. The PyPI
   and npm packages are released together at the same version, so
   `pip install testguard-cli==X.Y.Z` runs CLI X.Y.Z. npx needs network
   access the first time it fetches that version. If the wrapper cannot read
   its own version (it was not installed through pip), it exits 1 rather than
   run an unpinned CLI.

To run the CLI offline, or at a version other than the wheel's, also install
`testguard-cli` with npm in the project (or a parent directory) so step 2
answers.

### Homebrew

```bash
brew tap raccioly/tap
brew install testguard          # or in one step: brew install raccioly/tap/testguard
```

The formula depends on Homebrew's `node` and installs the published npm
tarball, checked against a `sha256` recorded at release time.

### GitHub Action

```yaml
- uses: actions/checkout@v7
  with: { fetch-depth: 0 }
- uses: raccioly/testguard@v0.18.3
  with: { command: gate }
```

The action is a composite: it sets up Node and runs
`npx -y testguard-cli@<version>` with the inputs you give it. Every input,
and complete pull-request and main-branch workflows, are in
[GitHub Actions](guides/ci/github-actions.md).

### pre-commit

```yaml
repos:
  - repo: https://github.com/raccioly/testguard
    rev: v0.18.3
    hooks:
      - id: testguard-claims
      - id: testguard-gate
      - id: testguard-probe
```

pre-commit installs the repository at `rev` into its own Node environment, so
the hooks run that version whatever the project has in `node_modules`. The
three hooks, their stages and their arguments are in
[pre-commit](guides/ci/pre-commit.md).

### GitLab CI

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/raccioly/testguard/v0.18.3/packaging/gitlab/testguard.gitlab-ci.yml'
    inputs: { dir: . }
```

The template adds a `testguard:gate` job and a `testguard:probe` job. Every
input is in [GitLab CI](guides/ci/gitlab.md).

## Verify the install

```bash
testguard --version             # prints the bare version number
command -v testguard            # which executable your shell resolves
node_modules/.bin/testguard --version   # the project's local install, if it has one
```

Two installs on one machine (a global Homebrew one and a project's
devDependency, say) can be different versions. The brief names the one that
answered: its first line reads `testguard <version> (local install)` when the
running CLI was started from a path inside a `node_modules` directory, and
`(global)` otherwise.

```text
testguard <version> (local install) @ bee6ee9530c6 — 1 claims, 1 faults probed, 1 unproven (no baseline; everything is new).
```

## Offline and air-gapped machines

The CLI itself never needs the network once installed. Getting it onto a
machine without registry access needs the six packages of the production
install. npm's own cache carries them:

```bash
# on a machine with registry access, in an empty directory
npm init -y
npm install --cache ./npm-cache -D testguard-cli@<version>

# copy ./npm-cache to the air-gapped machine, then in the project
npm install --offline --cache /path/to/npm-cache -D testguard-cli@<version>
npx --offline testguard --version
```

`--offline` makes npm refuse any network request, so the install either comes
entirely from the copied cache or fails.

pip alone is not an offline channel: when the wrapper finds no local
`node_modules/testguard-cli`, it falls back to `npx -y testguard-cli@<its own version>`.
Install the npm package offline as above and the wrapper runs it.

## Network and telemetry

The CLI collects nothing and sends nothing: no telemetry, no crash reports, no
update check, no socket. [`PRIVACY.md`](../PRIVACY.md) is the full statement.
What can reach the network is the channel around it, and only these:

| Who | When |
|---|---|
| npm / npx | installing the package, or `npx` running a package the project does not have |
| The pip wrapper | when no local `node_modules/testguard-cli` exists: `npx -y testguard-cli@<the pip package's version>` |
| Homebrew | `brew install` / `brew upgrade` |
| The GitHub Action and the GitLab template | every job runs `npx -y testguard-cli@<version>`; the GitLab template also installs the project's npm dependencies when `dir` has a `package.json` |
| The GitLab template, with `post_note: true` | posts the markdown brief to the merge request through the GitLab API |
| `.testguard/fetch-ci-evidence.sh` (from `init --ci-evidence`) | when you run it: `gh` or `glab` downloads CI's artifact |
| The MCP config printed by `init --mcp` | `npx -y testguard-cli mcp`, which fetches only when the package is not installed |
| An AI agent following the `init` instructions | optionally, once per session: `npm view testguard-cli dist-tags.latest` (see [Upgrading](upgrade.md#advisory-updates-for-ai-sessions)) |

The session-start hook that `init` writes never fetches. It runs the
project's `node_modules/.bin/testguard`, then a `testguard` already on `PATH`,
then nothing; there is no `npx` in it.

Evidence files contain repository-relative paths, test file names, claim
statements, content hashes, counts, durations and the commit sha. If you
upload them as CI artifacts, you publish that.

## Uninstall

Remove the package with the channel you installed it with:

```bash
npm uninstall -D testguard-cli               # npm devDependency
pip uninstall testguard-cli                  # pip wrapper
brew uninstall testguard && brew untap raccioly/tap   # Homebrew
```

For CI and hooks, delete the `uses: raccioly/testguard@…` steps, the GitLab
`include:` entry, or the `testguard-*` entries in `.pre-commit-config.yaml`.

`testguard init` wrote these files. Remove what you no longer want:

| What | Where | How to remove |
|---|---|---|
| The skill | `.claude/skills/testguard/SKILL.md` at the git root (or in the project with `--here`) | delete the `testguard` directory |
| The session-start hook | `.claude/settings.json`, a `SessionStart` entry whose command is `node_modules/.bin/testguard brief --text …` | delete that entry (one per project in a monorepo) |
| The `AGENTS.md` section | everything between `<!-- testguard:begin -->` and `<!-- testguard:end -->` | delete the block; if `init` created the file, it starts with `# Agent instructions` and can go entirely |
| The `.gitignore` lines | the project's `.gitignore`, under `# TestGuard: regenerated per run (baseline.json IS committed)` | delete the comment and the `.testguard/…` lines below it |
| The CI evidence helper (only with `--ci-evidence`) | `.testguard/fetch-ci-evidence.sh` | delete it |

Your own project files are not written by `init` and stay until you remove
them: `testguard.claims.json`, `testguard.ignore.json`,
`testguard.concerns.json` and the `.testguard/` directory (whose committed
file is `baseline.json`). See [artifacts](reference/artifacts.md) for what
each one is.

## Next

- [Quickstart](quickstart.md): from install to a first admitted test in ten minutes
- [Upgrading](upgrade.md): what an upgrade refreshes and what it does not
- [GitHub Actions](guides/ci/github-actions.md), [GitLab CI](guides/ci/gitlab.md), [pre-commit](guides/ci/pre-commit.md): wiring it into CI and hooks
- [Troubleshooting](troubleshooting.md): when the first run fails before a verdict
