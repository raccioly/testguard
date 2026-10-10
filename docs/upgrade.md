# Upgrading

This page covers moving a project to a newer TestGuard: how to upgrade on each
channel, the files an upgrade does **not** refresh, and what happens to
evidence and baselines written by an earlier version. Read it before you bump
the version in a project that already has claims, a baseline or an agent
layer.

## Before you start

Check what you are running now, and where from:

```bash
testguard --version               # the executable on PATH
node_modules/.bin/testguard --version   # the project's local install
```

Then read the [changelog](../CHANGELOG.md) entries between your version and
the new one. A release that changes how a verdict is reached says so in an
**Upgrading** section (0.7.0 has one), and that section is the migration
guide for that release.

## Upgrade each channel

| Channel | How to upgrade | Notes |
|---|---|---|
| npm devDependency | `npm i -D testguard-cli@latest`, or `@<version>` | Commit the lockfile. This is the copy the session-start hook runs. |
| npx | `npx testguard-cli@<version> <command>` | Name the version to be sure which one npx runs. |
| pip | `pip install -U testguard-cli` | This upgrades the wrapper only. The CLI it runs is the project's `node_modules/testguard-cli` when there is one, otherwise `npx -y testguard-cli@latest`; see [installation](installation.md#pip). |
| Homebrew | `brew upgrade testguard` | |
| GitHub Action | change the tag in `uses: raccioly/testguard@…` | The `version` input defaults to the CLI released with that tag. If you set `version` yourself, change it too. |
| GitLab CI | change the tag in the `include: remote:` URL | Same rule for the template's `version` input. |
| pre-commit | `pre-commit autoupdate --repo https://github.com/raccioly/testguard`, or edit `rev:` | The hooks run the version at `rev`, not the project's `node_modules`. |

Move every channel a project uses together. CI, the pre-commit hooks and the
local install each run their own copy, and two versions can disagree about a
verdict or refuse each other's evidence (see
[below](#evidence-and-baselines-across-versions)).

## What an upgrade does not refresh

`testguard init` **copies** files into the repository. Upgrading the package
changes none of them:

| File | What stays old | How to bring it forward |
|---|---|---|
| `.claude/skills/testguard/SKILL.md` | the whole skill, as copied by the `init` you ran | merge by hand, or `init --force` |
| The `AGENTS.md` section between `<!-- testguard:begin -->` and `<!-- testguard:end -->` | the instructions, once the section lists the project | edit by hand |
| The `SessionStart` hook in `.claude/settings.json` | the command, once it is present | usually nothing to do; see below |

Re-running `testguard init` after an upgrade is safe and does a little:

- It adds any `.gitignore` lines the new version regenerates and your file
  does not yet ignore.
- It upgrades a pre-0.6 session-start hook to the local-then-`PATH` form.
  The old forms ran `npx -y` or `npx --no-install`; the current one reaches no
  network. It also rewrites a pre-0.6 `AGENTS.md` section that has no project
  list.
- It leaves an existing skill, and a section that already lists the project,
  untouched. Its output says so with `=` lines.
- If the new version's hook command differs from the one you have, `init`
  adds the new entry beside the old one. Look at `.claude/settings.json`
  afterwards and delete the old entry.

### Merging the skill by hand

The new template ships inside the package. Compare it with your copy and take
the changes you approve, keeping any local customisations:

```bash
diff node_modules/testguard-cli/src/init/templates/SKILL.md .claude/skills/testguard/SKILL.md
```

For the `AGENTS.md` section, run `init` in a scratch directory to see the
current wording, then carry the changes you want into your section by hand.

### `init --force`

`testguard init --force` overwrites `.claude/skills/testguard/SKILL.md` with
the new template, losing any local edits, and with `--ci-evidence` it also
replaces `.testguard/fetch-ci-evidence.sh`. It does **not** refresh an
`AGENTS.md` section that already lists the project, and it does not rewrite a
hook that is already present. Use it only when replacing the whole skill is
what you want, and review the diff before you commit.

## Advisory updates for AI sessions

The `AGENTS.md` section and the skill written by current versions of
`testguard init` tell an AI agent to identify the CLI it actually runs
(project-local first, then the repository root, then `PATH`), read its
`--version`, and, once per session and only when network policy permits, read
the registry's stable version:

```bash
npm view testguard-cli dist-tags.latest --json --fetch-retries=0 --fetch-timeout=5000
```

This check is performed by the AI, not by TestGuard's CLI or its hook, and it
is optional:

- A newer stable version produces a suggestion and a request for approval,
  never an automatic install. Project pins, lockfiles, CI pins and the
  original package manager still apply.
- Versions are compared by SemVer. Prereleases and development checkouts are
  not replaced, and nothing is downgraded.
- An offline or failed check changes no verdict, evidence or exit code, and
  does not prove the installation is current.
- A declined suggestion is not repeated in the same session.

AI instructions are guidance, not a guarantee that every harness performs the
check. A project initialised before this advice existed does not get it from
an upgrade: merge the skill and the `AGENTS.md` section as described above.

## Evidence and baselines across versions

Every document TestGuard writes (evidence, baseline, brief, gate, status)
carries `schemaVersion: 1` and is validated before it is written. Evidence and
baselines are also validated when they are read, against the schemas of the
version that reads them. A document that does not conform is refused with
`… does not conform to the spec` and exit `2`.

### Evidence

`.testguard/evidence.json` is regenerated by every complete probe and is not
committed, so the simplest migration is a fresh probe:

```bash
npx testguard-cli probe --no-reuse    # does not read the previous evidence; re-probes every claim
```

Two cases make that worth doing after an upgrade:

- **The new version refuses the old evidence.** `probe` reads the previous
  evidence to reuse its verdicts. With `--no-reuse` it never opens that file,
  and the new run overwrites it.
- **The release notes say verdicts change.** A verdict is reused when the
  fault, its target, its defenders, discovery inputs and run policy match the
  previous record. The TestGuard version is not part of that match, so
  without `--no-reuse` an unchanged claim keeps the verdict the old version
  reached.

The reverse direction fails too. A newer version can write fields an older
version's schemas do not allow, and the older version then refuses the file.
This matters when you read CI's evidence with `status --evidence` or
`brief --evidence`: run the same version locally as CI.

### Baseline

`.testguard/baseline.json` is committed, so it outlives upgrades. It holds one
fingerprint per unproven finding: a SHA-256 of the claim id, the fault id, the
file and the verdict, defined in
[`spec/GATE-SEMANTICS.md`](../spec/GATE-SEMANTICS.md#baseline-and-delta).
The fault's `find`/`replace` text is not part of it, so repairing an anchor
does not churn the baseline.

The verdict **is** part of it. When an upgrade changes the verdict a finding
gets, the new fingerprint is not in your baseline and the finding gates as
new. 0.7.0 is the example: claims whose subject the defenders never executed
moved from `SURVIVED` to `UNVERIFIABLE`. In that case:

1. Run `probe` and read the findings that are new since the baseline.
2. Prefer fixing what they point at.
3. To accept them as existing debt, run `testguard baseline` to re-freeze
   today's findings, and commit the result. Do this after reading them, not
   instead of it.

## `baseline --restamp`

`baseline --restamp` moves an existing baseline's `head` (the commit it
describes) to the commit of a later clean probe. It exists for one situation:
a baseline frozen from a working-tree snapshot (`probe --include-dirty`)
points at the **parent** of the commit that will carry your new tests. After
you commit, a clean probe plus a restamp moves it to that commit.

```bash
git commit -am "test: …"
npx testguard-cli probe               # a clean probe of the new commit
npx testguard-cli baseline --restamp  # same fingerprints, so only head moves
```

It refuses, with exit `2` and the reason, when the evidence comes from a
snapshot or a dirty tree, or when the probe did not reproduce exactly the same
fingerprints. It never rewrites the frozen set: when the findings changed,
including after an upgrade, freeze a new baseline with `testguard baseline`
instead. The baseline keeps its original `createdAt` and records
`restampedAt`.

## Next

- [Installation](installation.md): every channel and how to verify which install answered
- [Artifacts](reference/artifacts.md): what each `.testguard/` file is and which to commit
- [AI agents](guides/ai-agents.md): the skill, the hook and the `AGENTS.md` section
- [Changelog](../CHANGELOG.md): what changed in each release
