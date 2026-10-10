# GitHub Actions

This guide wires TestGuard into GitHub Actions: the `gate` on every pull
request, the `probe` on pull requests and on the default branch, the evidence
as an artifact, and reading that evidence on your laptop. It is for whoever
owns the repository's workflows. Every input of the action is listed here with
its default.

The action is [`action.yml`](../../../action.yml) at the root of this
repository. It is a composite action with two steps: `actions/setup-node`
with the Node version you ask for, then
`npx -y testguard-cli@<version> <command> . <arguments>` in the working
directory. It does not check out your code and does not install your
dependencies; your workflow does both before it.

## Inputs

| Input | Default | Applies to | Meaning |
|---|---|---|---|
| `command` | `probe` | — | The command to run: `probe`, `claims`, `baseline`, `brief` or `gate`. `brief` is run with `--text`. |
| `working-directory` | `.` | all | Directory whose test runner is invoked, where `testguard.claims.json` lives. The command runs there with `.` as its directory. |
| `claims` | `''` | all | Path to the claims file, passed as `--claims`. Empty means `<working-directory>/testguard.claims.json`. |
| `severity` | `low` | `probe` | Gate only on findings at or above this severity: `critical`, `high`, `medium`, `low`. Findings below it are still reported; they just do not fail the step. |
| `confirm` | `3` | `probe` | Runs per verdict (N). Below 3 the run is provisional: verdicts print with `?` and the evidence goes to `.testguard/evidence-provisional.json`. |
| `budget` | `120000` | `probe` | Wall-clock budget per test run, in milliseconds. A run past it is `TIMEOUT`, never a kill. |
| `no-escalate` | `false` | `probe` | `true` skips re-running survivors against the whole suite. |
| `allow-empty` | `false` | `probe` | `true` skips a valid claims file with no claims, exits 0 and writes no evidence. For adoption only; see [below](#adopting-with-zero-claims). |
| `changed-ref` | `''` | `gate` | The reference the change is measured against. Empty on a `pull_request` event means `origin/<base branch>`, which the action fetches first. |
| `strict` | `false` | `gate` | `true` fails a change whose files were all excluded (non-source, or never-claimed patterns) instead of passing with a note. |
| `version` | the CLI release published with this action tag | all | The `testguard-cli` version to run. Leave it alone unless you deliberately run a different CLI from the same action. |
| `node-version` | `22` | all | Node.js version set up by the action (20 or later). It replaces any Node your job set up earlier, for this step and the ones after it. |
| `runner` | `auto` | `probe` | `vitest`, `jest`, `playwright`, `python`, `pytest`, `unittest`, `node-test` or `auto`. Any value other than `auto` is passed as `--runner`. `python` picks pytest when the interpreter can import it and stdlib `unittest` otherwise; `pytest` and `unittest` pin that choice and fail rather than fall back. |
| `python` | `''` | `probe` | Python interpreter for `.py` defenders. Empty means `$VIRTUAL_ENV`, then the project's `.venv`/`venv`, then `python3` on `PATH`. |

Inputs that do not apply to the chosen command are ignored. For a flag the
action has no input for (`--workers`, `--claim`, `--out`, `--include-dirty`
and so on), run the CLI directly in a `run:` step after `npm ci`; see the
[CLI reference](../../reference/cli.md). Environment variables such as
`TESTGUARD_NODE_MODULES` and `TESTGUARD_PYTHON` reach the CLI either way; see
[configuration](../../reference/configuration.md).

## Output

| Output | Value |
|---|---|
| `evidence` | Absolute path of the evidence file this run wrote, in the working directory; empty when it wrote none. |

The output names the file the run actually wrote: `.testguard/evidence.json`
for a complete, confirmed `probe`, and `.testguard/evidence-provisional.json`
for a provisional one (`confirm` below 3). It is empty for `gate`, `claims`,
`baseline` and `brief`, which write no evidence, for an `allow-empty` probe
that verified nothing, and for a probe that stopped before writing (a usage
error, a missing claims file). The step compares the evidence files before and
after the run, so an `evidence.json` restored from a cache that the run did not
rewrite is not reported. The output is set even when the step fails, so an
`if: always()` step after it can read it.

Inputs reach the step's script as environment variables, not as text spliced
into it, so a value containing quotes or `$(…)` is passed to the CLI as data.

## Exit codes

The step fails on any non-zero exit from the CLI:

| Exit | Meaning |
|---|---|
| `0` | nothing new to prove |
| `1` | unproven claims, unclaimed changed files, claim drift or invalid fault anchors |
| `2` | a precondition failed and nothing was probed (for example, no claims, or a detected base that does not resolve) |
| `3` | usage: a bad flag, or `gate` with no reference to compare against |

## `fetch-depth: 0`

`actions/checkout` fetches one commit by default. That breaks two things:

- **`gate`** computes the merge base of the base branch and `HEAD`. With one
  commit there is no merge base, and `gate` exits `2` telling you to check out
  with `fetch-depth: 0`. The action fetches the base branch when `changed-ref`
  is empty, but a shallow history still has no common ancestor.
- **`probe`** builds its scratch worktree from `HEAD`, and records for each
  kill whether the test and the code it guards came from the same change. In
  a shallow clone that record is `unknown`.

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
      - uses: raccioly/testguard@v0.18.3
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
      - uses: raccioly/testguard@v0.18.3
        with:
          command: probe
          severity: high               # fail only on new high or critical findings
```

A pull request's probe gates against the committed `.testguard/baseline.json`,
so only findings that are new since the baseline fail it. On a
`pull_request` event the action measures `gate` against
`origin/$GITHUB_BASE_REF`; set `changed-ref` to measure against something
else.

## Default-branch workflow: probe, reuse, publish the evidence

On the default branch, probe after every merge, carry the previous evidence
forward so unchanged claims reuse their verdicts, and publish the evidence
under a stable name so anyone can brief from it locally.

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
        uses: raccioly/testguard@v0.18.3
        with:
          command: probe

      # The fetch helper written by `init --ci-evidence github` downloads the
      # artifact testguard-evidence-<branch> and reads ci-self-evidence.json.
      - name: Name the evidence the way the fetch helper expects
        if: always()
        run: '[ -f .testguard/evidence.json ] && cp .testguard/evidence.json .testguard/ci-self-evidence.json || true'
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: testguard-evidence-${{ github.ref_name }}
          path: .testguard/ci-self-evidence.json
          if-no-files-found: warn
```

`if: always()` matters: a probe that finds a survivor fails the step, and that
is exactly the evidence you want to keep. Upload the branch-named artifact on
`push` only. On a pull request `github.ref_name` is `<number>/merge`, and an
artifact name cannot contain `/`.

Reuse is not a guarantee of a cheap run: a cold cache, changed discovery or
configuration, or a different `confirm` or worker policy re-probes in full.
See [performance](../performance.md) for what a probe costs.

If you do not use the fetch helper, upload the action's output directly.
Guard on it being non-empty: `upload-artifact` rejects an empty `path`.

```yaml
      - uses: actions/upload-artifact@v7
        if: always() && steps.testguard.outputs.evidence != ''
        with:
          name: testguard-evidence
          path: ${{ steps.testguard.outputs.evidence }}
          if-no-files-found: warn
```

## Python projects

Install the project's test dependencies the way you normally do, then point
the probe at the interpreter if it is not one TestGuard finds on its own
(`$VIRTUAL_ENV`, the project's `.venv` or `venv`, then `python3` on `PATH`):

```yaml
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: python -m venv .venv && .venv/bin/pip install -r requirements.txt
      - uses: raccioly/testguard@v0.18.3
        with:
          command: probe
          runner: python             # pytest if .venv can import it, else unittest
```

The action still needs Node: it sets up Node itself. Nothing is installed into
the Python environment; see [Python](../python.md).

## A project in a subdirectory

Set `working-directory` to the directory that holds `testguard.claims.json`.
Each project in a monorepo gets its own step, because a passing parent gate
says nothing about a child project's coverage:

```yaml
      - uses: raccioly/testguard@v0.18.3
        with:
          command: gate
          working-directory: services/billing
```

If the scratch worktree cannot see the project's `node_modules` (a hoisted
workspace, say), set `TESTGUARD_NODE_MODULES` in the step's `env:`. See
[monorepos](../monorepo.md).

## Adopting with zero claims

A project adopting TestGuard often merges the workflow before it has written a
claim. A plain `probe` exits `2` on a claims file with no claims, because a
run that verified nothing must not look like a pass. During adoption set
`allow-empty`:

```yaml
      - uses: raccioly/testguard@v0.18.3
        with:
          command: probe
          allow-empty: 'true'
```

With a valid, empty claims file the probe then exits `0`, prints
`claims file declares no claims; verification skipped (--allow-empty); run gate to check changed-file coverage`
and writes no evidence. A missing or invalid claims file still fails. It does
not check coverage of the change: run the `gate` job alongside it, so new code
arrives with claims from day one. Remove `allow-empty` once the first claim
lands. The full adoption path is in
[existing projects](../existing-projects.md).

## Read CI's evidence locally

The evidence lives where `probe` ran, and `.testguard/evidence.json` is
gitignored. On a fresh clone, or on a laptop where only CI probes, `status`
says `unprobed` and the session-start brief is empty although the default
branch has full evidence. Point either command at CI's document:

```bash
testguard status . --evidence .testguard/ci/ci-self-evidence.json
testguard brief . --text --evidence .testguard/ci/ci-self-evidence.json
```

A foreign document is not trusted blindly. `status` marks it
`evidenceSource: provided`, prints the commit it describes next to the commit
in your tree, and still computes staleness from the recorded input hashes, so
a file you edited since CI probed it shows as `evidence-stale` for exactly the
claims it affects.

To fetch the artifact without looking up a run id, write the helper once:

```bash
npx testguard-cli init --ci-evidence github   # writes .testguard/fetch-ci-evidence.sh
.testguard/fetch-ci-evidence.sh               # branch defaults to main
.testguard/fetch-ci-evidence.sh release       # or name one
```

The helper downloads the artifact `testguard-evidence-<branch>` with the `gh`
CLI into `.testguard/ci/` (which `init` gitignores) and then runs
`testguard brief . --text --evidence .testguard/ci/ci-self-evidence.json`.
It pairs with the default-branch workflow above. Commit the helper; it is one
of the `.testguard/` files that is not regenerated.

- **It is an on-demand helper, not a hook.** The session-start hook never
  touches the network. You run the helper when you want CI's view.
- It exits `0` with a message when `gh` is not installed, when no artifact
  exists for the branch, or when `testguard` is not on `PATH`. With only a
  devDependency install, run it as
  `PATH="$PWD/node_modules/.bin:$PATH" .testguard/fetch-ci-evidence.sh`.
- `init --force --ci-evidence github` replaces an existing helper.

## Next

- [GitLab CI](gitlab.md): the same gate and probe as an include template
- [pre-commit](pre-commit.md): the gate before every commit, the probe before every push
- [Performance](../performance.md): what a probe costs and why a gate gets slow
- [Troubleshooting](../../troubleshooting.md): when a CI run fails before a verdict
