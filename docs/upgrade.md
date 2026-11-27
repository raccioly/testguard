# Upgrading

This page explains how to move a project to a newer TestGuard. It covers how
to upgrade on each channel, which files an upgrade does **not** refresh, and
what happens to evidence and baselines that an earlier version wrote. Read it
before you change the version in a project that already has claims, a baseline
or an agent layer.

## Before you start

Check which version you run now, and where it comes from:

```bash
testguard --version               # the executable on PATH
node_modules/.bin/testguard --version   # the project's local install
```

Then read the [changelog](../CHANGELOG.md) entries between your version and
the new one. If a release changes how TestGuard reaches a verdict, the entry
says so in an **Upgrading** section (0.7.0 has one). That section is the
migration guide for that release.

## 0.24: fast by default

What changed by default:

- **Faults run in parallel.** `probe` uses `--fault-workers auto`: `min(4, floor(CPUs / 2))` faults at once, at least one. The number is halved when other test runners are busy. Every kill rests on at least one run with nothing else in flight. TestGuard detects a suite that shares a port or a database and measures it alone. So the default is sound for any suite.
- **`--serial` means one test process at a time**: one runner worker *and* one fault at a time. Before, it meant only one runner worker, which was already the default.
- **A `--claim` or `--changed` run reuses the last full probe** (`.testguard/evidence.json`).
- **`probe --changed auto`** finds the base offline. The pre-commit `testguard-probe` hook, the hook that `init` writes and the merge-request job of the GitLab component use it.
- **`status`, `brief` and the end of a probe print `advice`** where a run wastes time.

To get the old behavior back:

```bash
testguard probe --serial               # one fault at a time, this run
export TESTGUARD_FAULT_WORKERS=1       # one fault at a time, every run in this shell or CI job
```

In an existing project, run this command once and review the diff:

```bash
testguard init --upgrade
```

It rewrites what TestGuard wrote and nobody edited: the skill, the `AGENTS.md`
section, the pre-push block and the CI file from `init --ci`. It leaves
everything else unchanged. Then it lists every hook or CI line that still runs
`probe --serial`, a full probe on every push, or a pinned older version. It
says what to change, and you edit those lines. It also reports a block that
someone edited by hand. `--force` replaces that block.

## Stay current

TestGuard itself never makes a network call. Pick one way to get new releases:

| Way | Prefer it when | What to do |
|---|---|---|
| A pinned devDependency, bumped by a bot | the project has a `package.json` | What `testguard init --pin` sets up (plain `init` only recommends it). It adds `testguard-cli` at exactly its own version to `devDependencies`. It writes a Dependabot rule, or a Renovate rule when the repository uses Renovate. Each release then arrives as a pull request that your CI gates. Run your install once so the lockfile records the pin. |
| The exact version through npx | there is no `package.json` (a Python project) | The pre-push hook and CI use this when nothing is installed: `npx -y testguard-cli@<the version that ran init>`. `testguard init --upgrade` raises the version. TestGuard never writes a floating tag. `init` reports one that it finds (`floating-version`), because a floating tag runs a release that nobody reviewed. |
| Homebrew | one machine runs many repositories | `brew tap raccioly/tap && brew install testguard`, then `brew upgrade testguard`. |

This Dependabot file (`.github/dependabot.yml`) groups TestGuard into its own
pull request:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      testguard:
        patterns: ["testguard-cli"]
```

This workflow (`.github/workflows/testguard-automerge.yml`) merges that pull
request when CI is green:

```yaml
name: TestGuard auto-merge
on: pull_request
permissions:
  contents: write
  pull-requests: write
jobs:
  automerge:
    if: github.actor == 'dependabot[bot]' && contains(github.head_ref, 'testguard')
    runs-on: ubuntu-latest
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--auto` waits for the required checks. Enable auto-merge and branch
protection on the repository. This is the Renovate file (`renovate.json`):

```json
{
  "packageRules": [
    { "matchPackageNames": ["testguard-cli"], "groupName": "testguard", "automerge": true }
  ]
}
```

After any upgrade, run `testguard init --upgrade` once.

## Upgrade each channel

| Channel | How to upgrade | Notes |
|---|---|---|
| npm devDependency | `npm i -D --save-exact testguard-cli@<version>`, or merge the bot's pull request | Commit the lockfile. This is the copy the session-start hook, the pre-push hook and CI run. |
| npx | `npx testguard-cli@<version> <command>` | Name the version to be sure which one npx runs. |
| pip | `pip install -U testguard-cli` | This upgrades the wrapper only. The CLI it runs is the project's `node_modules/testguard-cli` when there is one, otherwise `npx -y testguard-cli@<version>` at the wrapper's own version, so upgrading the wrapper upgrades that CLI too; see [installation](installation.md#pip). |
| Homebrew | `brew upgrade testguard` | |
| GitHub Action | change the tag in `uses: raccioly/testguard@…` | The `version` input defaults to the CLI released with that tag. If you set `version` yourself, change it too. |
| GitLab CI | change the tag in the `include: remote:` URL | Same rule for the template's `version` input. |
| pre-commit | `pre-commit autoupdate --repo https://github.com/raccioly/testguard`, or edit `rev:` | The hooks run the version at `rev`, not the project's `node_modules`. |

Move every channel that a project uses at the same time. CI, the pre-commit
hooks and the local install each run their own copy. Two versions can disagree
about a verdict, or refuse each other's evidence (see
[below](#evidence-and-baselines-across-versions)).

## What an upgrade does not refresh

`testguard init` **copies** files into the repository. An upgrade of the package
changes none of them:

| File | What stays old | How to bring it forward |
|---|---|---|
| `.claude/skills/testguard/SKILL.md` | the whole skill, as copied by the `init` you ran | `init --upgrade` when unmodified; merge by hand, or `init --force` |
| The `AGENTS.md` section between `<!-- testguard:begin … -->` and `<!-- testguard:end -->` | the instructions, once the section lists the project | `init --upgrade` when it is an unmodified template; an edited section is left alone and reported |
| The pre-push block (`.husky/pre-push` or `.githooks/pre-push`) and the CI file from `init --ci` | the commands | `init --upgrade` when unmodified; `--force` otherwise |
| The `SessionStart` hook in `.claude/settings.json` | the command, once it is present | usually nothing to do; see below |

It is safe to run `testguard init` again after an upgrade. It does a little:

- It adds any `.gitignore` lines that the new version regenerates and your
  file does not yet ignore.
- It upgrades a pre-0.6 session-start hook to the local-then-`PATH` form.
  The old forms ran `npx -y` or `npx --no-install`. The current form uses no
  network. It also rewrites a pre-0.6 `AGENTS.md` section that has no project
  list.
- It leaves an existing skill, and a section that already lists the project,
  unchanged. Its output says so with `=` lines. Its output lists with `~` what
  `init --upgrade` would rewrite, and the hook and CI lines that run TestGuard
  in a slow or stale way.
- `init --upgrade` rewrites every block that TestGuard wrote and nobody
  edited. Each block carries `template=<n>` and the hash of its own body.
  TestGuard recognizes a skill or an `AGENTS.md` section that it wrote before
  markers existed by the hash of every template it shipped. TestGuard reports
  anything that someone edited, or that it cannot prove unmodified. It never
  overwrites such a block without `--force`. A hook file that already mentions
  TestGuard outside a managed block belongs to the project and gets no block.
- If the hook command of the new version differs from yours, `init` replaces
  your TestGuard hook in place. It does this for each project, in the root and
  in every subdirectory. The hook keeps its position and any other keys on it.
  `init` also removes duplicates that an older `init` left. It does not touch
  other hooks.
- It adds the `.gitignore` lines that a newer release introduced, directly
  after the TestGuard lines already there, and nothing else.

### Merging the skill by hand

The new template ships inside the package. Compare it with your copy. Take the
changes you approve and keep your local customizations:

```bash
diff node_modules/testguard-cli/src/init/templates/SKILL.md .claude/skills/testguard/SKILL.md
```

For the `AGENTS.md` section, run `init` in a scratch directory to see the
current wording. Then copy the changes you want into your section by hand.

### `init --force`

`testguard init --force` overwrites `.claude/skills/testguard/SKILL.md` with
the new template and loses any local edits. With `--ci-evidence`, it also
replaces `.testguard/fetch-ci-evidence.sh`. It does **not** refresh an
`AGENTS.md` section that already lists the project. The hook does not need
`--force`, because a plain `init` already replaces an earlier hook. Use
`--force` only when you want to replace the whole skill. Review the diff before
you commit.

## Advisory updates for AI sessions

The `AGENTS.md` section and the skill that current versions of `testguard init`
write tell an AI agent to do three things. First, identify the CLI that it
actually runs: project-local first, then the repository root, then `PATH`.
Second, read the `--version` of that CLI. Third, read the stable version in the
registry. The agent does this once per session, and only when network policy
permits:

```bash
npm view testguard-cli dist-tags.latest --json --fetch-retries=0 --fetch-timeout=5000
```

The AI does this check. TestGuard's CLI and its hook do not. The check is
optional:

- A newer stable version produces a suggestion and a request for approval.
  The agent never installs it automatically. Project pins, lockfiles, CI pins
  and the original package manager still apply.
- Versions are compared by SemVer. The agent does not replace prereleases or
  development checkouts, and it never downgrades.
- An offline or failed check changes no verdict, evidence or exit code. It does
  not prove that the installation is current.
- The agent does not repeat a declined suggestion in the same session.

AI instructions are guidance. They do not guarantee that every harness
performs the check. An upgrade does not add this advice to a project that you
initialized before the advice existed. Merge the skill and the `AGENTS.md`
section as described above.

## Evidence and baselines across versions

Every document that TestGuard writes (evidence, baseline, brief, gate, status)
carries `schemaVersion: 1`. TestGuard validates it before it writes it.
TestGuard also validates evidence and baselines when it reads them, against
the schemas of the version that reads them. It refuses a document that does not
conform, with `… does not conform to the spec` and exit `2`.

### Evidence

Every complete probe regenerates `.testguard/evidence.json`, and you do not
commit it. So the simplest migration is a fresh probe:

```bash
npx testguard-cli probe --no-reuse    # does not read the previous evidence; re-probes every claim
```

Do this after an upgrade in two cases:

- **The new version refuses the old evidence.** `probe` reads the previous
  evidence to reuse its verdicts. With `--no-reuse`, it never opens that file,
  and the new run overwrites it.
- **The release notes say verdicts change.** TestGuard reuses a verdict when
  the fault, its target, its defenders, the discovery inputs and the run policy
  match the previous record. The TestGuard version is not part of that match.
  So without `--no-reuse`, an unchanged claim keeps the verdict that the old
  version reached.

The reverse direction fails too. A newer version can write fields that the
schemas of an older version do not allow. The older version then refuses the
file. This matters when you read the evidence of CI with `status --evidence`
or `brief --evidence`. Run the same version locally as in CI.

### Baseline

You commit `.testguard/baseline.json`, so it survives upgrades. It holds one
fingerprint per unproven finding. The fingerprint is a SHA-256 of the claim id,
the fault id, the file and the verdict.
[`spec/GATE-SEMANTICS.md`](../spec/GATE-SEMANTICS.md#baseline-and-delta)
defines it. The `find`/`replace` text of the fault is not part of the
fingerprint. So when you repair an anchor, the baseline does not change.

The verdict **is** part of the fingerprint. An upgrade can change the verdict
that a finding gets. Then the new fingerprint is not in your baseline, and the
finding gates as new. 0.7.0 is the example: claims whose subject the defenders
never executed moved from `SURVIVED` to `UNVERIFIABLE`. In that case:

1. Run `probe` and read the findings that are new since the baseline.
2. Prefer to fix what they point at.
3. To accept them as existing debt, run `testguard baseline` to freeze today's
   findings again, and commit the result. Do this after you read the findings,
   not instead of reading them.

## `baseline --restamp`

`baseline --restamp` moves the `head` of an existing baseline (the commit that
the baseline describes) to the commit of a later clean probe. It exists for one
situation. You froze a baseline from a working-tree snapshot
(`probe --include-dirty`). That baseline points at the **parent** of the commit that
will carry your new tests. After you commit, run a clean probe and then a
restamp. The restamp moves the baseline to that commit.

```bash
git commit -am "test: …"
npx testguard-cli probe               # a clean probe of the new commit
npx testguard-cli baseline --restamp  # same fingerprints, so only head moves
```

It refuses, with exit `2` and the reason, in two cases. The first case is
evidence from a snapshot or a dirty tree. The second case is a probe that did
not reproduce exactly the same fingerprints. It never rewrites the frozen set.
When the findings changed, including after an upgrade, freeze a new baseline
with `testguard baseline` instead. The baseline keeps its original `createdAt`
and records `restampedAt`.

## Next

- [Installation](installation.md): every channel and how to verify which install answered
- [Artifacts](reference/artifacts.md): what each `.testguard/` file is and which to commit
- [AI agents](guides/ai-agents.md): the skill, the hook and the `AGENTS.md` section
- [Changelog](../CHANGELOG.md): what changed in each release
