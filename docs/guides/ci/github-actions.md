# GitHub Actions

This guide connects TestGuard to GitHub Actions. You get the `gate` on every
pull request and the `probe` on pull requests and on the default branch. You
get the evidence as an artifact, and you can read that evidence on your laptop.
The guide is for whoever owns the repository's workflows. It lists every input
of the action with its default.

The action is [`action.yml`](../../../action.yml) at the root of this
repository. It is a composite action with two steps. First, `actions/setup-node`
sets up the Node version you ask for. Then
`npx -y testguard-cli@<version> <command> . <arguments>` runs in the working
directory. The action does not check out your code and does not install your
dependencies. Your workflow must do both before the action runs.

## Inputs

| Input | Default | Applies to | Meaning |
|---|---|---|---|
| `command` | `probe` | — | The command to run: `probe`, `claims`, `baseline`, `brief` or `gate`. `brief` is run with `--text`. |
| `working-directory` | `.` | all | Directory whose test runner is invoked, where `testguard.claims.json` lives. The command runs there with `.` as its directory. |
| `claims` | `''` | all | Path to the claims file, passed as `--claims`. Empty means `<working-directory>/testguard.claims.json`. |
| `severity` | `low` | `probe` | Gate only on findings at or above this severity: `critical`, `high`, `medium`, `low`. The action still reports findings below it, but they do not fail the step. |
| `confirm` | `3` | `probe` | Runs per verdict (N). Below 3, the run is provisional: verdicts print with `?` and the evidence goes to `.testguard/evidence-provisional.json`. |
| `budget` | `120000` | `probe` | Wall-clock budget per test run, in milliseconds. A run that goes past it is `TIMEOUT`, never a kill. |
| `no-escalate` | `false` | `probe` | `true` skips re-running survivors against the whole suite. |
| `allow-empty` | `false` | `probe` | `true` skips a valid claims file with no claims, exits 0 and writes no evidence. Use it for adoption only. See [below](#adopting-with-zero-claims). |
| `changed` | `''` | `probe` | `auto` probes only the claims the pull request can affect. It finds the base offline: the pull request's base branch, then the remote default branch. A ref names the base. Empty probes every claim, so keep that for the nightly or `push` job. Faults already run in parallel (half the CPUs, at most 4), and a run alone confirms every kill. Check out with `fetch-depth: 0`. |
| `changed-ref` | `''` | `gate` | The reference the change is measured against. On a `pull_request` event, empty means `origin/<base branch>`, which the action fetches first. |
| `strict` | `false` | `gate` | `true` fails a change whose files were all excluded (non-source, or never-claimed patterns). Without it, the change passes with a note. |
| `version` | the CLI release published with this action tag | all | The `testguard-cli` version to run. Change it only if you want to run a different CLI from the same action. |
| `node-version` | `22` | all | Node.js version that the action sets up (20 or later). It replaces any Node that your job set up earlier, for this step and the steps after it. |
| `runner` | `auto` | `probe` | `vitest`, `jest`, `playwright`, `python`, `pytest`, `unittest`, `node-test` or `auto`. Any value other than `auto` is passed as `--runner`. `python` picks pytest when the interpreter can import it and stdlib `unittest` otherwise; `pytest` and `unittest` pin that choice and fail rather than fall back. |
| `python` | `''` | `probe` | Python interpreter for `.py` defenders. Empty means `$VIRTUAL_ENV`, then the project's `.venv`/`venv`, then `python3` on `PATH`. |

The action ignores inputs that do not apply to the chosen command. Some flags
have no action input (`--workers`, `--claim`, `--out`, `--include-dirty`
and so on). For those, run the CLI directly in a `run:` step after `npm ci`.
See the [CLI reference](../../reference/cli.md). Environment variables such as
`TESTGUARD_NODE_MODULES` and `TESTGUARD_PYTHON` reach the CLI either way. See
[configuration](../../reference/configuration.md).

## Output

| Output | Value |
|---|---|
| `evidence` | Absolute path of the evidence file this run wrote, in the working directory; empty when it wrote none. |

The output names the file that the run actually wrote. For a complete,
confirmed `probe`, that is `.testguard/evidence.json`. For a provisional one
(`confirm` below 3), it is `.testguard/evidence-provisional.json`.

The output is empty in these cases:

- `gate`, `claims`, `baseline` and `brief` write no evidence.
- An `allow-empty` probe verified nothing.
- A probe stopped before it wrote (a usage error, a missing claims file).

The step compares the evidence files before and after the run. If the run did
not rewrite an `evidence.json` that a cache restored, the step does not report
it. The step sets the output even when it fails, so an `if: always()` step
after it can read the output.

Inputs reach the step's script as environment variables, not as text inserted
into it. So a value that contains quotes or `$(…)` goes to the CLI as data.

## Exit codes

The step fails on any non-zero exit from the CLI:

| Exit | Meaning |
|---|---|
| `0` | nothing new to prove |
| `1` | unproven claims, unclaimed changed files, claim drift or invalid fault anchors |
| `2` | a precondition failed and nothing was probed (for example, no claims, or a detected base that does not resolve) |
| `3` | usage: a bad flag, or `gate` with no reference to compare against |

## `fetch-depth: 0`

`actions/checkout` fetches one commit by default. This breaks two things:

- **`gate`** computes the merge base of the base branch and `HEAD`. With one
  commit there is no merge base. Then `gate` exits `2` and tells you to check
  out with `fetch-depth: 0`. The action fetches the base branch when
  `changed-ref` is empty, but a shallow history still has no common ancestor.
- **`probe`** builds its scratch worktree from `HEAD`. For each kill, it
  records whether the test and the code it guards came from the same change.
  In a shallow clone, that record is `unknown`.

Check out with `fetch-depth: 0` for both.

## Pull request workflow

The gate is fast and runs no tests. The probe runs your suite N times per
fault, so it needs your dependencies installed.

```yaml
name: TestGuard
on:
  pull_request:

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0               # the base branch must exist locally
      - uses: raccioly/testguard@v0.26.3
        with:
          command: gate                # every changed source file needs a claim

  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci                    # the probe runs the project's own test runner
      - uses: raccioly/testguard@v0.26.3
        with:
          command: probe
          severity: high               # fail only on new high or critical findings
```

A pull request's probe gates against the committed `.testguard/baseline.json`,
so only findings that are new since the baseline fail it. On a
`pull_request` event, the action measures `gate` against
`origin/$GITHUB_BASE_REF`. To measure against something else, set
`changed-ref`.

## Default-branch workflow: probe, reuse, publish the evidence

On the default branch, probe after every merge. Carry the previous evidence
forward, so unchanged claims reuse their verdicts. Publish the evidence
under a stable name, so anyone can brief from it locally.

```yaml
name: TestGuard probe
on:
  push:
    branches: [main]

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci

      # A verdict is reused when its fault, target, defenders, discovery inputs
      # and run policy are unchanged; only what changed is probed again.
      - name: Restore the previous evidence
        uses: actions/cache@v6
        with:
          path: .testguard/evidence.json
          key: testguard-evidence-${{ hashFiles('testguard.claims.json') }}-${{ github.sha }}
          restore-keys: |
            testguard-evidence-${{ hashFiles('testguard.claims.json') }}-
            testguard-evidence-

      - id: testguard
        uses: raccioly/testguard@v0.26.3
        with:
          command: probe

      # The fetch helper written by `init --ci-evidence github` downloads the
      # artifact testguard-evidence-<branch> and briefs from the evidence file
      # in it (evidence.json, or evidence-provisional.json below confirm 3).
      - uses: actions/upload-artifact@v7
        if: always() && steps.testguard.outputs.evidence != ''
        with:
          name: testguard-evidence-${{ github.ref_name }}
          path: ${{ steps.testguard.outputs.evidence }}
          if-no-files-found: warn
```

`always()` matters. A probe that finds a survivor fails the step, and you
want to keep exactly that evidence. The `evidence` output is empty when the
run wrote no evidence, so the condition skips the upload instead of failing
it. Upload the branch-named artifact on `push` only. On a pull request,
`github.ref_name` is `<number>/merge`, and an artifact name cannot contain
`/`.

Reuse does not guarantee a cheap run. A cold cache, changed discovery or
configuration, or a different `confirm` or worker policy makes the probe run in
full again. See [performance](../performance.md) for what a probe costs.

If you do not use the fetch helper, upload the action's output directly.
Check that it is not empty, because `upload-artifact` rejects an empty `path`.

```yaml
      - uses: actions/upload-artifact@v7
        if: always() && steps.testguard.outputs.evidence != ''
        with:
          name: testguard-evidence
          path: ${{ steps.testguard.outputs.evidence }}
          if-no-files-found: warn
```

## Python projects

Install the project's test dependencies the way you normally do. TestGuard
finds an interpreter on its own (`$VIRTUAL_ENV`, the project's `.venv` or
`venv`, then `python3` on `PATH`). If yours is not one of those, point the
probe at it:

```yaml
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: python -m venv .venv && .venv/bin/pip install -r requirements.txt
      - uses: raccioly/testguard@v0.26.3
        with:
          command: probe
          runner: python             # pytest if .venv can import it, else unittest
```

The action still needs Node, and it sets up Node itself. It installs nothing
into the Python environment. See [Python](../python.md).

## A project in a subdirectory

Set `working-directory` to the directory that holds `testguard.claims.json`.
Give each project in a monorepo its own step. A passing parent gate says
nothing about a child project's coverage:

```yaml
      - uses: raccioly/testguard@v0.26.3
        with:
          command: gate
          working-directory: services/billing
```

Sometimes the scratch worktree cannot see the project's `node_modules` (a
hoisted workspace, for example). Then set `TESTGUARD_NODE_MODULES` in the
step's `env:`. See [monorepos](../monorepo.md).

## Adopting with zero claims

A project that adopts TestGuard often merges the workflow before it has written
a claim. A plain `probe` exits `2` on a claims file with no claims, because a
run that verified nothing must not look like a pass. During adoption, set
`allow-empty`:

```yaml
      - uses: raccioly/testguard@v0.26.3
        with:
          command: probe
          allow-empty: 'true'
```

With a valid, empty claims file, the probe then exits `0`, prints
`claims file declares no claims; verification skipped (--allow-empty); run gate to check changed-file coverage`
and writes no evidence. A missing or invalid claims file still fails. The
probe does not check coverage of the change. Run the `gate` job alongside it,
so new code arrives with claims from day one. Remove `allow-empty` when the
first claim lands. The full adoption path is in
[existing projects](../existing-projects.md).

## Read CI's evidence locally

The evidence stays where `probe` ran, and git ignores `.testguard/evidence.json`.
On a fresh clone, or on a laptop where only CI probes, `status` says `unprobed`
and the session-start brief is empty. This happens although the default branch
has full evidence. Point either command at CI's document:

```bash
testguard status . --evidence .testguard/ci/evidence.json
testguard brief . --text --evidence .testguard/ci/evidence.json
```

TestGuard does not trust a foreign document blindly. `status` marks it
`evidenceSource: provided` and prints the commit it describes next to the
commit in your tree. It still computes staleness from the recorded input
hashes. So if you edited a file since CI probed it, the claims that file
affects show as `evidence-stale`, and only those claims.

To fetch the artifact without a run id, write the helper once:

```bash
npx testguard-cli init --ci-evidence github   # writes .testguard/fetch-ci-evidence.sh
.testguard/fetch-ci-evidence.sh               # branch defaults to main
.testguard/fetch-ci-evidence.sh release       # or name one
```

The helper downloads the artifact `testguard-evidence-<branch>` with the `gh`
CLI into a freshly emptied `.testguard/ci/` (which `init` gitignores). Then it
runs `brief . --text --evidence .testguard/ci/evidence.json`. It pairs with the
default-branch workflow above, which uploads the file that the action's
`evidence` output names. The helper also reads `evidence-provisional.json` (a
run below `confirm: 3`, briefed as provisional) and `ci-self-evidence.json`
(the name an earlier version of this example used). Commit the helper. It is
one of the `.testguard/` files that TestGuard does not regenerate.

- **It is an on-demand helper, not a hook.** The session-start hook never
  uses the network. You run the helper when you want CI's view.
- It runs the same CLI the session-start hook would run: the project's
  `node_modules/.bin/testguard`, then the repository root's, then a
  `testguard` on `PATH`. A devDependency install needs nothing more.
- It exits `0` with a message when `gh` is not installed, when it finds no
  TestGuard CLI, when no artifact exists for the branch, or when the artifact
  holds no evidence file.
- `init --force --ci-evidence github` replaces an existing helper.

## Next

- [GitLab CI](gitlab.md): the same gate and probe as an include template
- [pre-commit](pre-commit.md): the gate before every commit, the probe before every push
- [Performance](../performance.md): what a probe costs and why a gate gets slow
- [Troubleshooting](../../troubleshooting.md): when a CI run fails before a verdict
