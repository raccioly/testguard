# Troubleshooting

Use this page when TestGuard stops before it reaches a verdict, or reaches a
verdict that you do not believe. Find the message you saw. Then read why it
happens and what to do. The messages come from the code, so you can search for
the exact words you got.

TestGuard refuses instead of guessing. Almost every error below is a
precondition. If TestGuard ignored it, the report would look confident and
be wrong. Exit code `2` means that one of these preconditions failed and
nothing was probed. See [exit codes](reference/cli.md#exit-codes).

## Installing

### `ENOVERSIONS` from npm

Your project's `.npmrc` sets `min-release-age`. The version you asked for is
newer than that age. Install it explicitly:

```bash
npm i -D testguard-cli --min-release-age=0
```

### `testguard: command not found` after `pip install`

The PyPI package is a thin wrapper that runs the Node CLI. It needs Node ≥ 20
on `PATH`. Check with `node --version`. See [installation](installation.md).

## Before the first run

### `claims file declares no claims; nothing to verify`

`probe` exits `2` on an empty claims file. This is on purpose: a green run
that checked nothing must not look like a pass. While you adopt TestGuard, use
`probe --allow-empty`. It exits `0` and says that it skipped verification. Run
`gate` to enforce coverage of changed files. See
[adopting in an existing project](guides/existing-projects.md#4-gate-new-changes-from-today).

### `claims file … does not conform to the spec`

The claims file failed schema validation. Every line after the message names
the field. Point your editor at the schema, and it flags these errors as you
type:

```json
{ "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json" }
```

### `ignore document … does not conform to the spec` or `concerns document … does not conform to the spec`

This is the same check, for `testguard.ignore.json` or
`testguard.concerns.json`. The command exits `2`, and the lines after the
message name the field. An ignore file has two common causes:

- `/entries/N/kind: must be equal to one of the allowed values: path, claim, fault`.
  Earlier schemas accepted a `fingerprint` entry, but TestGuard never read it,
  so it suppressed nothing. Remove it. To accept a known finding, freeze it
  with `testguard baseline`.
- `a fault entry names one fault exactly, as <claimId>/<faultId>` (or the
  `claim` equivalent). TestGuard matches `claim` and `fault` patterns exactly.
  A glob or a bare claim ID in a `fault` entry would excuse nothing, or too
  much.

`cannot read concerns document …` (or `ignore document`) means the file is not
valid JSON. The message ends with the error from the parser.

See [the ignore file](reference/configuration.md#ignore-file) and
[the concerns file](reference/configuration.md#concerns-file).

### `--claim: unknown claim id …`

The ID is not in the claims file that TestGuard reads. Check the spelling. In a
monorepo, check that you are in the project directory that owns the claim.

## Runner and dependencies

### `vitest is not installed in the project and \`vitest\` is not on PATH`

TestGuard looks for a JavaScript runner in the **project's own package**
first. Only then does it look on `PATH`. It never asks `npx`, because `npx`
can answer with a version that the project does not use. Declare the runner as
a development dependency (`npm i -D vitest`), or pick another runner with
`--runner`. The same message exists for jest and `@playwright/test`.

### `test runner is not resolvable in the scratch worktree … If dependencies are missing, pass --node-modules <path>, or run with --in-place`

Probes run in a scratch worktree, and `node_modules` is not part of git.
TestGuard links your dependencies into the worktree. If your layout is one that
TestGuard cannot find (a hoisted workspace root or a custom install location),
the worktree has no dependencies. Pass the directory explicitly:

```bash
npx testguard probe --node-modules ../../node_modules   # or set TESTGUARD_NODE_MODULES
```

`--in-place` avoids the worktree and applies the faults to your working tree.
It is safe, because TestGuard restores every fault. But your tree changes
while the probe runs, so do not edit files during an in-place probe.

### `discovery config … imports unresolved module …`

TestGuard reads the configuration of your runner (`vitest.config.*`,
`jest.config.*`, `playwright.config.*`) to find the test files that the runner
collects. The config imports a package that is not installed. Install the
dependencies (`npm ci`) before you probe. In CI, run the install step before
TestGuard.

### `… is not in any resolved runner's configured test universe`

A file in `defendedBy` is not a file that your runner collects, so running it
would prove nothing. Either the path is wrong, or your runner config excludes
the file. Fix the path or the config. TestGuard does not run a test that your
own runner ignores.

### `Karma was found …`, `Maven was found …` or `Gradle was found …`

`auto` found no runner it may pick, and your project says it is built with Karma,
Maven or Gradle. TestGuard never chooses these three on its own. Run it again
with `--runner karma`, `--runner maven` or `--runner gradle`. The message names
what is missing if that runner cannot start: `karma-junit-reporter`, a Karma
config, `@angular/cli`, a `pom.xml`, or a wrapper or tool on PATH. None of these
adapters has been run against a real project by its authors; read the first
result before you trust a large run
([languages and runners](reference/languages-and-runners.md#maven)).

### `the build wrote no test report`

A Maven or Gradle run left no JUnit XML. A compile error does this, and the
message then carries the compiler's first line (the engine records a fault as
`fault-invalid` and a defender as a load failure). A selector that matched no
test does it too: the defender is not under `src/test/java` or `src/test/kotlin`,
or its class has no test method. TestGuard removes the report directories before
each run, so an old report is never read in its place.

### Using a runner TestGuard does not know

Use `--runner-cmd` with `{files}` and `{out}` placeholders and a
jest-compatible JSON report, or JUnit XML with `--report-format junit`. See
[languages and runners](reference/languages-and-runners.md).

## Probing

### `N defender/target files have uncommitted changes … worktree mode probes HEAD …, so those changes would be silently ignored`

Worktree mode probes a **commit**. If your new test is uncommitted, a probe of
HEAD runs without it. The probe returns the same survivors and gives no hint
why. Choose what you mean:

| You want | Flag |
|---|---|
| Probe the working tree as it is now | `--include-dirty` |
| Probe HEAD and knowingly skip your edits | `--ignore-dirty` (the evidence records the skipped files) |
| Probe a specific commit, such as a pre-fix one | `--ref <commit>` |
| Fault your working tree directly | `--in-place` |

### `N test runners are already running … a suite that times out under parallel load yields TIMEOUT or FLAKY-DEFENDER`

Another test process is competing for the CPU. It is often the watch mode of
your editor, or a second agent. Verdicts under contention describe the load,
not the claim. Stop the other runner, or pass `--serial`. The evidence records
the contention either way. TestGuard halves an automatic fault-worker count.

### It takes too long, or it gets stuck

Read [why is this slow?](guides/performance.md#why-is-this-slow). It lists
these causes: an old version, `--serial` in a hook or CI, a full probe on every
push, no evidence cache in CI, and expensive or shared defender files.
`testguard status` lists `advice` lines, each with the command to run. For a
probe that prints nothing, see [below](#a-probe-that-seems-to-hang).

### Failures only when several probes run at once

Two things can compete for the same machine: the fault workers of your own
probe, and other probes or test runners.

- **Other runners.** The probe warns before the first run (`N test runners are
  already running`) and records `run.contention`. TestGuard halves an automatic
  width. Verdicts under load can be `TIMEOUT` or `FLAKY-DEFENDER`.
- **Two probes of one repository** take turns creating and removing scratch
  worktrees through a lock (`testguard-worktrees.lock`, outside the
  repository). A probe waits up to two minutes for a live owner of the lock.
- **The fault workers of the probe.** A timeout, an inconsistent probe, or a
  suite that failed to load beside other faults is measured again alone
  (`detail.remeasuredSerially`) before TestGuard reports it.
- **A suite that shares a port, a database or a temp path** fails beside
  itself. TestGuard never reports a kill from those runs. Every kill rests on
  a run with nothing else in flight. If a run alone passes, TestGuard marks the
  set `detail.notParallelSafe` and names its files in a warning. Then it
  measures the faults of that set one at a time. Make those tests hermetic: use
  a port or a directory derived from `TESTGUARD_WORKER`, which every runner
  process gets. Or declare the claim `"serial": true`. TestGuard never reports
  a load error, a `fault-invalid` or an `unverifiable` that it measured beside
  another fault. It measures it again alone first (#287).

### Everything is `FLAKY-DEFENDER`

The defenders were not green on unmodified code in every one of the N runs, or
they disagreed. You cannot trust any verdict about a fault until you fix this.
`detail.flakeRate` in the evidence says how often they failed. Fix the flake
first. Common causes are order dependence, wall-clock time, shared temporary
files and network calls in tests.

### Everything is `TIMEOUT`

There are two possible causes. The fault can make the code hang. That is a
real finding, and the fix is a test with a bounded wait that fails on the
fault. Or the defender set is too slow for `--budget`. Check the baseline
duration in the evidence. If the clean suite takes almost the whole budget,
raise `--budget` or narrow the defenders. See
[performance](guides/performance.md).

### `UNVERIFIABLE` with an anchor reason

The `find` string of the fault no longer matches the source exactly once. The
code moved, or the line now appears twice. Run
`testguard claims --check-anchors` to see every broken anchor without running a
test. Repair the
fault so that it keeps its meaning, then probe again. TestGuard never moves an
anchor for you.

### Python: `the fault was applied to …, but the interpreter imported … instead`

Python loaded a different copy of the module than the copy that TestGuard
faulted. Every claim would then read `SURVIVED`, however good your tests are.
The usual cause is a strict editable install (an import hook ahead of
`sys.path`) or an old copy in `site-packages`. Reinstall the project against
the tree that you probe, or run with `--in-place`. See
[Python](guides/python.md).

### Python: `the defenders never imported …`

This is a warning, not an error. No defender imported the faulted module. So
the result tells you how far the tests reach and tells you nothing about their
assertions. The record carries `detail.targetNotImported`. Add a test that
imports the module, or fix `defendedBy`.

### A probe that seems to hang

A probe runs the defenders N times clean and N times per fault. On a real
suite this takes minutes. Progress always goes to stderr. In CI or a redirected
log, the probe prints one line per stage. If you see nothing, check that you
did not pass `--quiet` or `--progress none`. `--progress ndjson` streams every
stage and verdict as JSON for a harness to follow. Limit the whole run with
`--command-budget <ms>`.

## In CI

### `cannot resolve --changed <ref> … In CI the base must be present locally`

`gate` measures the change against a base commit, and a shallow clone does not
have that commit. On GitHub, check out with `fetch-depth: 0`. On GitLab, the
merge request diff base needs nothing extra. A branch name needs `GIT_DEPTH: 0`
or a `git fetch origin <target>`. See
[GitHub Actions](guides/ci/github-actions.md) and [GitLab](guides/ci/gitlab.md).

### The session brief is empty, but CI has evidence

Evidence stays where `probe` ran, and git ignores it. Point `status` and
`brief` at the document that CI produced with `--evidence <file>`.
`init --ci-evidence github` writes a helper that downloads it. See
[GitHub Actions](guides/ci/github-actions.md).

## Results you do not believe

| Symptom | Likely cause | What to check |
|---|---|---|
| A test you just wrote does not kill the fault | It passes with the fault applied | Apply `find` → `replace` by hand and run the test; or `testguard admit <test> --claim <ID>` |
| `NOCOVER` although a test imports the module | The test mocks the module | `testguard claims` prints the import/mock split; a mocking file is not a defender |
| `SURVIVED [killed-by-undeclared-tests: …]` | Other tests catch it | Add those files to the claim's `defendedBy` |
| A survivor disappeared without a new test | Its fault was edited | `testguard status` lists faults changed after they survived (`changedFaults`) |
| A claim disappeared | It was deleted | `testguard claims --since origin/main` reports removed claims and their last verdict |

## Still stuck

Open an issue with the command, the full output, `testguard --version`, your
Node version and your runner. See [SUPPORT.md](../SUPPORT.md). Do not paste
private source code. The [known-answer fixture](../fixtures/known-answer/README.md)
is a neutral place to reproduce a problem.

## Next

- [FAQ](faq.md)
- [Verdicts](reference/verdicts.md)
- [CLI reference](reference/cli.md)
