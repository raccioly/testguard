# GitLab CI

This guide wires TestGuard into GitLab CI with the include template this
repository publishes: a gate on every merge request, a probe on merge requests
and on the default branch, the brief as an artifact and, if you opt in, as a
merge-request note. It is for whoever owns the project's `.gitlab-ci.yml`.
Every template input is listed here with its default.

The template is
[`packaging/gitlab/testguard.gitlab-ci.yml`](../../../packaging/gitlab/testguard.gitlab-ci.yml).
It declares `spec: inputs:`, so it is shaped like a CI/CD component.

## Include it

Pin the include to a release tag, so the template and the CLI version it runs
move together:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/raccioly/testguard/v0.18.3/packaging/gitlab/testguard.gitlab-ci.yml'
    inputs:
      dir: backend          # where testguard.claims.json lives (default ".")
      post_note: "true"     # post the brief on the merge request; needs TESTGUARD_GITLAB_TOKEN
```

That adds two jobs to your pipeline:

| Job | Runs on | What it does | Artifacts (kept on failure too) |
|---|---|---|---|
| `testguard:gate` | merge request pipelines | `testguard gate .`: fails when a changed source file carries no claim and no excusing ignore entry. Runs no tests. | `.testguard/gate.json` |
| `testguard:probe` | merge request pipelines and the default branch | `testguard probe . --quiet` with the probe inputs, then writes the brief whatever the probe's exit code, then posts the note if asked. The job's exit code is the probe's. | `.testguard/evidence.json`, `.testguard/brief.json`, `.testguard/brief.md` |

Both jobs extend a hidden `.testguard` job that uses the `image` input, the
`stage` input, and runs `cd "$TESTGUARD_DIR"` and `npm ci --ignore-scripts`
before the script. Each TestGuard command runs as
`npx -y "testguard-cli@${TESTGUARD_VERSION}"`.

## Inputs

| Input | Default | Used by | Meaning |
|---|---|---|---|
| `version` | the CLI release published with this template tag | both jobs | The `testguard-cli` version to run. Leave it alone unless you deliberately run a different CLI from the same template. |
| `dir` | `.` | both jobs | Directory whose test runner is invoked, where `testguard.claims.json` lives. |
| `image` | `node:22` | both jobs | Container image for both jobs. It needs Node 20 or later, and Python too when you probe Python. |
| `severity` | `low` | probe | Gate only on findings at or above this severity: `critical`, `high`, `medium`, `low`. Findings below it are still reported. |
| `confirm` | `3` | probe | Runs per verdict (N). Below 3 the run is provisional and writes `.testguard/evidence-provisional.json`, which the job does not keep as an artifact. |
| `budget` | `120000` | probe | Wall-clock budget per test run, in milliseconds. |
| `no_escalate` | `false` | probe | `true` skips re-running survivors against the whole suite. |
| `runner` | `auto` | probe | `vitest`, `jest`, `playwright`, `python`, `pytest`, `unittest` or `auto`; any value other than `auto` is passed as `--runner`, so `node-test` works too. `python` picks pytest when the interpreter can import it and stdlib `unittest` otherwise; `pytest` and `unittest` pin that choice and fail rather than fall back. |
| `python` | `""` | probe | Python interpreter for `.py` defenders. Empty means `$VIRTUAL_ENV`, then the project's `.venv`/`venv`, then `python3` on `PATH`. |
| `strict` | `false` | gate | `true` fails a change whose files were all excluded instead of passing with a note. |
| `post_note` | `false` | probe | `true` posts the markdown brief as a merge-request note. Needs `TESTGUARD_GITLAB_TOKEN`; see [below](#the-merge-request-note). |
| `stage` | `test` | both jobs | Pipeline stage for both jobs. |

The template declares no input types, so every input is a string. Quote the
switches (`"true"`); the scripts compare them against the string `"true"`.

## How the gate finds the base

`testguard gate` with no `--changed` detects the base from the environment, in
this order:

1. `TESTGUARD_CHANGED_REF`, if you set it.
2. `CI_MERGE_REQUEST_DIFF_BASE_SHA`: the exact diff base GitLab gives a merge
   request pipeline. It needs no extra fetch.
3. `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, as `origin/<target>`. This one needs
   the branch locally: `GIT_DEPTH: 0`, or `git fetch origin <target>` before
   the job.

The template's gate job runs only on merge request pipelines, where step 2
answers. If you add a gate on another kind of pipeline, set
`TESTGUARD_CHANGED_REF` and fetch that ref. A base that is detected but does
not resolve fails the gate with exit `2`.

## `GIT_DEPTH`

The template sets `GIT_DEPTH: "0"` in its top-level `variables:`. The probe
builds a scratch git worktree from `HEAD` and records, for each kill, whether
the test and the code came from the same change; that record is `unknown` in a
shallow clone. Full history is the safe default.

Top-level `variables:` in an included file are pipeline-wide, so every job in
the pipeline now clones with full history. If that is too slow for your other
jobs, set `GIT_DEPTH` on those jobs.

## The merge-request note

With `post_note: "true"` on a merge request pipeline, the probe job posts
`.testguard/brief.md` (the `brief --markdown` output: unclaimed changes first,
then the ranked blind spots) as **one** note on the merge request, and updates
that same note on later runs. It finds its earlier note by the marker on the
note's first line, `<!-- testguard:brief -->`, among the latest 100 notes.

It needs a token, because `CI_JOB_TOKEN` cannot write notes:

1. Create a project or group access token with the `api` scope.
2. Add it as a CI/CD variable named `TESTGUARD_GITLAB_TOKEN`, masked. A
   *protected* variable is only exposed to pipelines on protected branches, so
   a merge request from an unprotected branch would not see it.

When the token is missing the job says so and leaves the brief in the
artifacts. A failure to list, post or update the note is printed and never
fails the job: the note is a convenience for the reviewer, the probe's exit
code is the gate.

The CLI itself never talks to the network. The note is posted by a few lines
of Node in the template's script, through the GitLab API, and only when you
set `post_note: "true"`.

## Things the template assumes

- **A lockfile in `dir`.** Each job runs `npm ci --ignore-scripts` in `dir`,
  and `npm ci` fails without a `package-lock.json` (or
  `npm-shrinkwrap.json`). A Python-only project with no `package.json` needs
  its own job that installs Node and runs `npx -y testguard-cli@<version>`
  directly.
- **Node and, for Python, Python in one image.** The default `node:22` image
  has no Python. Set `image` to one that carries both before probing a Python
  project, and point `python` at the interpreter if your dependencies live in
  a virtual environment the job creates.
- **`dir: .` for the artifacts.** The artifact paths are written as
  `.testguard/…`, and GitLab resolves artifact paths from the repository root,
  not from the directory the script changed into. With `dir` set to a
  subdirectory the files are written under `<dir>/.testguard/` and the
  artifact paths do not match them. Until that changes, extend the jobs and
  set `artifacts: paths:` to `<dir>/.testguard/…` yourself.

## Read CI's evidence locally

The probe job's artifacts include `.testguard/evidence.json`. To brief from
the default branch's evidence on your laptop, write the GitLab helper once:

```bash
npx testguard-cli init --ci-evidence gitlab   # writes .testguard/fetch-ci-evidence.sh
.testguard/fetch-ci-evidence.sh               # branch defaults to main
```

The helper runs `glab ci artifact <branch> testguard:probe` into
`.testguard/ci/` and then
`testguard brief . --text --evidence .testguard/ci/.testguard/evidence.json`.
It runs the same CLI the session-start hook would (the project's
`node_modules/.bin/testguard`, then the repository root's, then `PATH`), and
exits `0` with a message when `glab` is missing, when no TestGuard CLI is
found, or when there is no artifact for the branch. The session-start hook
never runs it; you do, when you want CI's view. How a foreign evidence file is
read (its commit named, staleness still computed from the recorded hashes) is
described in [GitHub Actions](github-actions.md#read-cis-evidence-locally).

## As a catalog component

The template carries `spec: inputs:` with the same inputs as above. Mirrored
into a GitLab project of your own, it can be published to the CI/CD catalog
and included with `include: component:` instead of `include: remote:`, with
the same `inputs:`. A compliance framework can then require it on every
project in a group. Follow GitLab's component documentation for the project
layout a catalog component needs.

## Next

- [GitHub Actions](github-actions.md): the same gate and probe as an action
- [pre-commit](pre-commit.md): the gate before every commit, the probe before every push
- [Adopting TestGuard in an existing project](../existing-projects.md): the order to turn things on
- [Troubleshooting](../../troubleshooting.md): when a CI run fails before a verdict
