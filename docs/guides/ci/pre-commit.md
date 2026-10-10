# pre-commit

This guide runs TestGuard from the [pre-commit](https://pre-commit.com)
framework: the claims check and the change gate before every commit, the probe
before every push. It is for developers who want the CI answer before CI gives
it. CI stays authoritative; these hooks are the fast loop in front of it.

The hooks are published in
[`.pre-commit-hooks.yaml`](../../../.pre-commit-hooks.yaml) at the root of
this repository.

## The three hooks

| Hook id | Command it runs | Stage | Speed |
|---|---|---|---|
| `testguard-claims` | `testguard claims` | every stage you install (normally `pre-commit`) | fast: validates `testguard.claims.json` against the spec and reports `@claim` drift |
| `testguard-gate` | `testguard gate --changed HEAD --include-dirty --quiet` | every stage you install (normally `pre-commit`) | fast: fails when a changed source file in the working tree carries no claim, does not defend one, and is not excused by `testguard.ignore.json`; runs no tests |
| `testguard-probe` | `testguard probe --quiet` | `pre-push` only | slow: injects every claim's faults and fails on any the tests miss, gated by the committed baseline |

All three use `language: node`, `pass_filenames: false` and
`always_run: true`: TestGuard decides what changed from git, not from the file
list pre-commit passes, and it runs even when no staged file matches a
pattern. `testguard-probe` declares `minimum_pre_commit_version: '3.2.0'` for its
`pre-push` stage name.

`gate --changed HEAD --include-dirty` compares the working tree (staged,
unstaged and untracked files) against `HEAD`. That is the only form of the
gate that sees a commit before it exists.

## Recommended configuration

```yaml
# .pre-commit-config.yaml
default_install_hook_types: [pre-commit, pre-push]
repos:
  - repo: https://github.com/raccioly/testguard
    rev: v0.18.3
    hooks:
      - id: testguard-claims
        stages: [pre-commit]
      - id: testguard-gate
        stages: [pre-commit]
      - id: testguard-probe          # pre-push, from the hook definition
```

```bash
pre-commit install            # installs both hook types listed above
```

Without `default_install_hook_types`, install the push stage once per clone:

```bash
pre-commit install
pre-commit install --hook-type pre-push
```

`stages: [pre-commit]` on the two fast hooks keeps them from running a second
time at push. A hook with no `stages` runs at every installed stage, and at
push the gate would measure only uncommitted edits, not the commits being
pushed.

## Arguments

Anything in `args:` is appended to the hook's command, so it reaches the CLI
as ordinary flags and a trailing directory:

```yaml
      - id: testguard-probe
        args: [--allow-empty]          # adoption: a valid empty claims file passes
      - id: testguard-gate
        args: [--strict]               # an all-excluded change fails instead of passing with a note
      - id: testguard-claims
        args: [services/billing]       # a project in a subdirectory
```

`--allow-empty` is for adoption. With a valid claims file that declares no
claims, `probe` exits `0`, says that no verification was performed, and
writes no evidence; without the flag it exits `2`. A missing or invalid claims
file still fails. It does not check coverage of the change, which is the
`testguard-gate` hook's job, so keep that hook on. Remove the flag when the
first claim lands.

In a monorepo, give each project its own entries with the project directory
as the argument. A passing gate at the root says nothing about a child project
that has its own claims file; see [monorepos](../monorepo.md).

## What runs, and which version

pre-commit installs this repository at `rev` into an isolated Node
environment and runs the `testguard` from there. The hooks therefore run the
version named by `rev`, whatever version the project has in `node_modules`.
Move `rev` when you upgrade the project's dependency (or run
`pre-commit autoupdate`), so the hook and CI give the same answer. TestGuard
needs Node 20 or later in that environment.

The probe hook runs the **project's** test runner: vitest, jest and Playwright
are resolved from the project's own `node_modules`, so install the project's
dependencies first.

## Before you push

The probe hook probes the commit you are pushing, in a scratch git worktree;
your working tree is never touched. If a file that a claim targets or defends
has uncommitted changes, the probe refuses with exit `2` instead of silently
probing the committed version, and the push stops. Commit or stash those
changes, then push.

A probe runs each fault's defenders three times, so the push waits for it.
Unchanged claims reuse their earlier verdicts from `.testguard/evidence.json`;
see [performance](../performance.md) for what a probe costs and how to keep
it short. To push without running the hooks once, `git push --no-verify`
skips them; CI still runs the gate and the probe.

## Next

- [GitHub Actions](github-actions.md): the authoritative gate and probe in CI
- [GitLab CI](gitlab.md): the same jobs as an include template
- [Writing claims](../writing-claims.md): what to do when the gate names an unclaimed file
- [Troubleshooting](../../troubleshooting.md): when a hook fails before a verdict
