# GitLab CI

This guide connects TestGuard to GitLab CI with the include template this
repository publishes. You get a gate on every merge request and a probe on
merge requests and on the default branch. You get the brief as an artifact.
If you opt in, you also get the brief as a merge-request note. The guide is for
whoever owns the project's `.gitlab-ci.yml`. It lists every template input with
its default.

The template is
[`packaging/gitlab/testguard.gitlab-ci.yml`](../../../packaging/gitlab/testguard.gitlab-ci.yml).
It declares `spec: inputs:`, so it has the shape of a CI/CD component.

## Include it

Pin the include to a release tag. Then the template and the CLI version it
runs change together:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/raccioly/testguard/v0.26.3/packaging/gitlab/testguard.gitlab-ci.yml'
    inputs:
      dir: backend          # where testguard.claims.json lives (default ".")
      post_note: true       # post the brief on the merge request; needs TESTGUARD_GITLAB_TOKEN
```

That adds two jobs to your pipeline:

| Job | Runs on | What it does | Artifacts (kept on failure too) |
|---|---|---|---|
| `testguard:gate` | merge request pipelines | `testguard gate .`: fails when a changed source file carries no claim and no excusing ignore entry. Runs no tests. | `<dir>/.testguard/gate.json` |
| `testguard:probe` | merge request pipelines and the default branch | `testguard probe . --quiet` with the probe inputs (on a merge request, `--changed auto` unless `changed` is empty), then writes the brief whatever the probe's exit code, then posts the note if asked. The job's exit code is the probe's. | `<dir>/.testguard/evidence.json` (or `evidence-provisional.json` when `confirm` is below 3), `<dir>/.testguard/brief.json`, `<dir>/.testguard/brief.md` |

`<dir>` is the `dir` input; with the default `.` the artifacts are under
`.testguard/` at the repository root.

Both jobs extend a hidden `.testguard` job. That job uses the `image` and
`stage` inputs and sets `TESTGUARD_VERSION`, `TESTGUARD_DIR` and `GIT_DEPTH` as
its own variables. Before the script runs, it does `cd "$TESTGUARD_DIR"` and
installs the project's npm dependencies (the test runner lives there):

| In `dir` | Install step |
|---|---|
| `package-lock.json` or `npm-shrinkwrap.json` | `npm ci --ignore-scripts` |
| `package.json` without a lockfile | `npm install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund`: installs into `node_modules` without writing a lockfile or changing `package.json` |
| no `package.json` (a Python-only project) | nothing; the job says so and goes on |

The template never installs the CLI into the project. Each TestGuard command
runs as `npx -y "testguard-cli@${TESTGUARD_VERSION}"`.

## Inputs

| Input | Default | Used by | Meaning |
|---|---|---|---|
| `version` | the CLI release published with this template tag | both jobs | The `testguard-cli` version to run. Leave it alone unless you deliberately run a different CLI from the same template. |
| `dir` | `.` | both jobs | Directory whose test runner is invoked, where `testguard.claims.json` lives. |
| `image` | `node:22` | both jobs | Container image for both jobs. It needs Node 20 or later, and Python too when you probe Python. |
| `severity` | `low` | probe | Gate only on findings at or above this severity: `critical`, `high`, `medium`, `low` (GitLab rejects any other value). Findings below it are still reported. |
| `confirm` | `3` | probe | Runs per verdict (N), a number. Below 3 the run is provisional and writes `.testguard/evidence-provisional.json`, which the job keeps as its artifact in place of `evidence.json`. |
| `budget` | `120000` | probe | Wall-clock budget per test run, in milliseconds, a number. |
| `no_escalate` | `false` | probe | `true` skips re-running survivors against the whole suite. |
| `runner` | `auto` | probe | `vitest`, `jest`, `playwright`, `python`, `pytest`, `unittest`, `node-test`, `maven`, `gradle`, `karma` or `auto` (GitLab rejects any other value); any value other than `auto` is passed as `--runner`. `python` picks pytest when the interpreter can import it and stdlib `unittest` otherwise; `pytest` and `unittest` pin that choice and fail rather than fall back. |
| `python` | `""` | probe | Python interpreter for `.py` defenders. Empty means `$VIRTUAL_ENV`, then the project's `.venv`/`venv`, then `python3` on `PATH`. |
| `changed` | `auto` | probe | On a merge request pipeline, `--changed auto`: only the claims the change can affect (the base is `CI_MERGE_REQUEST_DIFF_BASE_SHA`). Empty probes every claim. Pipelines on the default branch always probe every claim. The job caches `.testguard/evidence.json`, so unchanged verdicts are carried forward. |
| `strict` | `false` | gate | `true` fails a change whose files were all excluded instead of passing with a note. |
| `post_note` | `false` | probe | `true` posts the markdown brief as a merge-request note. Needs `TESTGUARD_GITLAB_TOKEN`; see [below](#the-merge-request-note). |
| `stage` | `test` | both jobs | Pipeline stage for both jobs. |

`no_escalate`, `strict` and `post_note` are `type: boolean`: write them
unquoted, `post_note: true`. `confirm` and `budget` are `type: number`.
GitLab checks each value against its declared type when it includes the
template: a quoted `"true"` is a string, and GitLab can reject it for a
boolean input. Every other input is a string.

## How the gate finds the base

`testguard gate` with no `--changed` detects the base from the environment. It
checks these in order:

1. `TESTGUARD_CHANGED_REF`, if you set it.
2. `CI_MERGE_REQUEST_DIFF_BASE_SHA`: the exact diff base that GitLab gives a
   merge request pipeline. It needs no extra fetch.
3. `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, as `origin/<target>`. This one needs
   the branch locally. Set `GIT_DEPTH: 0`, or run `git fetch origin <target>`
   before the job.

The template's gate job runs only on merge request pipelines, where step 2
gives the answer. If you add a gate on another kind of pipeline, set
`TESTGUARD_CHANGED_REF` and fetch that ref. If the gate detects a base but
cannot resolve it, the gate fails with exit `2`.

## `GIT_DEPTH`

The template sets `GIT_DEPTH: "0"` on its own two jobs, through the hidden
`.testguard` job's `variables:`. The probe builds a scratch git worktree from
`HEAD`. For each kill, it records whether the test and the code came from the
same change. In a shallow clone, that record is `unknown`. Full history is the
safe default.

The template has no top-level `variables:`, because those would apply to
every job in the including pipeline. Your other jobs keep their clone depth.
To make the TestGuard jobs clone less history, override the variable on
them:

```yaml
testguard:gate:
  variables:
    GIT_DEPTH: "50"
```

## The merge-request note

With `post_note: true` on a merge request pipeline, the probe job posts
`.testguard/brief.md` (the `brief --markdown` output: unclaimed changes first,
then the ranked blind spots) as **one** note on the merge request, and updates
that same note on later runs. It finds its earlier note by the marker on the
note's first line, `<!-- testguard:brief -->`, among the latest 100 notes.

It needs a token, because `CI_JOB_TOKEN` cannot write notes.

1. Create a project or group access token with the `api` scope.
2. Add it as a CI/CD variable named `TESTGUARD_GITLAB_TOKEN`, masked. A
   *protected* variable is only exposed to pipelines on protected branches, so
   a merge request from an unprotected branch would not see it.

When the token is missing, the job says so and leaves the brief in the
artifacts. If the job fails to list, post or update the note, it prints the
failure and does not fail the job. The note helps the reviewer. The probe's
exit code is the gate.

The CLI itself never talks to the network. A few lines of Node in the
template's script post the note through the GitLab API. They do this only when
you set `post_note: true`.

## Things the template assumes

- **npm for JavaScript dependencies.** The install step knows npm's
  lockfiles only. A Yarn or pnpm project gets `npm install` without a
  lockfile, which resolves versions again. Override `before_script` on the
  jobs to install the way your project does.
- **Node and, for Python, Python in one image.** The default `node:22` image
  has no Python. Before you probe a Python project, set `image` to one that
  has both. If your dependencies live in a virtual environment that the job
  creates, point `python` at the interpreter. The template installs no Python
  packages. Add that step after the template's own step, which has already
  changed into `dir`:

  ```yaml
  testguard:probe:
    before_script:
      - !reference [.testguard, before_script]
      - python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  ```

## Read CI's evidence locally

The probe job's artifacts include `.testguard/evidence.json`. To get a brief
from the default branch's evidence on your laptop, write the GitLab helper
once:

```bash
npx testguard-cli init --ci-evidence gitlab   # writes .testguard/fetch-ci-evidence.sh
.testguard/fetch-ci-evidence.sh               # branch defaults to main
```

The helper runs `glab ci artifact <branch> testguard:probe` into
`.testguard/ci/` and then
`testguard brief . --text --evidence .testguard/ci/.testguard/evidence.json`.
For a project in a subdirectory, the artifact keeps the project's path. The
helper reads `.testguard/ci/<dir>/.testguard/evidence.json`, never another
project's evidence from the same artifact.

It runs the same CLI the session-start hook would run: the project's
`node_modules/.bin/testguard`, then the repository root's, then `PATH`. It
exits `0` with a message when `glab` is missing, when it finds no TestGuard
CLI, or when the branch has no artifact. The session-start hook never runs the
helper. You run it when you want CI's view. TestGuard names the commit of a
foreign evidence file and still computes staleness from the recorded hashes.
See [GitHub Actions](github-actions.md#read-cis-evidence-locally) for how it
reads that file.

## As a catalog component

The template carries `spec: inputs:` with the same inputs as above. Mirror it
into a GitLab project of your own to publish it to the CI/CD catalog. Then
include it with `include: component:` instead of `include: remote:`, with
the same `inputs:`. A compliance framework can then require it on every
project in a group. Follow GitLab's component documentation for the project
layout that a catalog component needs.

## Next

- [GitHub Actions](github-actions.md): the same gate and probe as an action
- [pre-commit](pre-commit.md): the gate before every commit, the probe before every push
- [Adopting TestGuard in an existing project](../existing-projects.md): the order to turn things on
- [Troubleshooting](../../troubleshooting.md): when a CI run fails before a verdict
