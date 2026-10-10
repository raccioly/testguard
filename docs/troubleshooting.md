# Troubleshooting

This page is for the moment TestGuard stops before it reaches a verdict, or
reaches one you do not believe. Find the message you saw, then read why it
happens and what to do. The messages are quoted from the code, so you can
search for the exact words you got.

TestGuard refuses rather than guesses. Almost every error below is a
precondition that, if ignored, would have produced a confident and wrong
report. Exit code `2` means one of these preconditions failed and nothing was
probed; see [exit codes](reference/cli.md#exit-codes).

## Installing

### `ENOVERSIONS` from npm

Your project's `.npmrc` sets `min-release-age`, and the version you asked for
was published more recently than that. Install it explicitly:

```bash
npm i -D testguard-cli --min-release-age=0
```

### `testguard: command not found` after `pip install`

The PyPI package is a thin wrapper that runs the Node CLI, so it needs Node ≥ 20
on `PATH`. Check with `node --version`. See [installation](installation.md).

## Before the first run

### `claims file declares no claims; nothing to verify`

`probe` exits `2` on an empty claims file, on purpose: a green run that
checked nothing must not look like a pass. While you adopt, use
`probe --allow-empty`, which exits `0` and says verification was skipped, and
run `gate` to enforce coverage of changed files. See
[adopting in an existing project](guides/existing-projects.md#4-gate-new-changes-from-today).

### `claims file … does not conform to the spec`

The claims file failed schema validation. Every line after the message names
the field. Point your editor at the schema so it flags these as you type:

```json
{ "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json" }
```

### `ignore document … does not conform to the spec` or `concerns document … does not conform to the spec`

The same check, for `testguard.ignore.json` or `testguard.concerns.json`; the
command exits `2` and the lines after the message name the field. Two common
causes in an ignore file:

- `/entries/N/kind: must be equal to one of the allowed values: path, claim, fault`.
  A `fingerprint` entry was accepted by earlier schemas but never read, so it
  suppressed nothing. Remove it; to accept a known finding, freeze it with
  `testguard baseline`.
- `a fault entry names one fault exactly, as <claimId>/<faultId>` (or the
  `claim` equivalent). `claim` and `fault` patterns are matched exactly; a glob
  or a bare claim ID in a `fault` entry would excuse nothing, or too much.

`cannot read concerns document …` (or `ignore document`) means the file is not
valid JSON; the message ends with the parser's error.

See [the ignore file](reference/configuration.md#ignore-file) and
[the concerns file](reference/configuration.md#concerns-file).

### `--claim: unknown claim id …`

The ID is not in the claims file being read. Check the spelling and, in a
monorepo, that you are in the project directory that owns the claim.

## Runner and dependencies

### `vitest is not installed in the project and \`vitest\` is not on PATH`

TestGuard resolves a JavaScript runner from the **project's own package**
first and only then from `PATH`. It never asks `npx`, because `npx` would
answer with a version the project does not use. Declare the runner as a
development dependency (`npm i -D vitest`), or pick another one with
`--runner`. The same message exists for jest and `@playwright/test`.

### `test runner is not resolvable in the scratch worktree … If dependencies are missing, pass --node-modules <path>, or run with --in-place`

Probes run in a scratch git worktree, and `node_modules` is not part of git.
TestGuard links your dependencies into it, but a layout it cannot find (a
hoisted workspace root, a custom install location) leaves the worktree without
them. Pass the directory explicitly:

```bash
npx testguard probe --node-modules ../../node_modules   # or set TESTGUARD_NODE_MODULES
```

`--in-place` avoids the worktree entirely by faulting your working tree. It
is safe (every fault is restored), but your tree is modified while it runs,
so do not edit files during an in-place probe.

### `discovery config … imports unresolved module …`

TestGuard reads your runner's own configuration (`vitest.config.*`,
`jest.config.*`, `playwright.config.*`) to find the test files the runner
would collect. The config imports a package that is not installed. Install
dependencies (`npm ci`) before probing. In CI, run the install step before
TestGuard.

### `… is not in any resolved runner's configured test universe`

A file in `defendedBy` is not a file your runner would collect, so running
it would prove nothing. Either the path is wrong, or your runner config
excludes it. Fix the path or the config; TestGuard will not run a test your
own runner ignores.

### Using a runner TestGuard does not know

Use `--runner-cmd` with `{files}` and `{out}` placeholders and a
jest-compatible JSON report. See
[languages and runners](reference/languages-and-runners.md).

## Probing

### `N defender/target files have uncommitted changes … worktree mode probes HEAD …, so those changes would be silently ignored`

Worktree mode probes a **commit**. If your new test is uncommitted, probing
HEAD would run without it and return the same survivors with no hint why.
Choose what you meant:

| You want | Flag |
|---|---|
| Probe the working tree as it is now | `--include-dirty` |
| Probe HEAD and knowingly skip your edits | `--ignore-dirty` (the evidence records the skipped files) |
| Probe a specific commit, such as a pre-fix one | `--ref <commit>` |
| Fault your working tree directly | `--in-place` |

### `N test runners are already running … a suite that times out under parallel load yields TIMEOUT or FLAKY-DEFENDER`

Another test process (often your editor's watch mode, or a second agent) is
competing for the CPU. Verdicts under contention describe the load, not the
claim. Stop the other runner, or pass `--serial`. The evidence records the
contention either way.

### Everything is `FLAKY-DEFENDER`

The defenders were not green on unmodified code in every one of the N runs,
or they disagreed. No verdict about a fault can be trusted until that is
fixed. `detail.flakeRate` in the evidence says how often they failed. Fix the
flake first; common causes are order dependence, wall-clock time, shared
temporary files and network calls in tests.

### Everything is `TIMEOUT`

Either the fault makes the code hang (a real finding, and the fix is a test
with a bounded wait that fails on it), or the defender set is too slow for
`--budget`. Check the baseline duration in the evidence; if the clean suite
is close to the budget, raise `--budget` or narrow the defenders. See
[performance](guides/performance.md).

### `UNVERIFIABLE` with an anchor reason

The fault's `find` string no longer matches the source exactly once: the code
moved or the line now appears twice. Run `testguard claims --check-anchors`
to see every broken anchor without running a test. Repair the fault so it
keeps its meaning, then re-probe. TestGuard never relocates an anchor for you.

### Python: `the fault was applied to …, but the interpreter imported … instead`

Python loaded a different copy of the module than the one TestGuard faulted,
so every claim would have read `SURVIVED` however good your tests are. The
usual cause is a strict editable install (an import hook ahead of `sys.path`)
or a stale copy in `site-packages`. Reinstall the project against the tree
being probed, or run with `--in-place`. See [Python](guides/python.md).

### Python: `the defenders never imported …`

A warning, not an error. No defender imported the faulted module, so the
result says something about the tests' reach and nothing about their
assertions. The record carries `detail.targetNotImported`. Add a test that
imports the module, or fix `defendedBy`.

### A probe that seems to hang

Probes run the defenders N times clean and N times per fault, which takes
minutes on a real suite. Progress always goes to stderr; in CI or a
redirected log it prints one line per stage. If you see nothing, check that
you did not pass `--quiet` or `--progress none`. `--progress ndjson` streams
every stage and verdict as JSON for a harness to follow. Bound the whole run
with `--command-budget <ms>`.

## In CI

### `cannot resolve --changed <ref> … In CI the base must be present locally`

`gate` measures the change against a base commit, and a shallow clone does
not have it. On GitHub, check out with `fetch-depth: 0`. On GitLab, the merge
request diff base needs nothing extra; a branch name needs `GIT_DEPTH: 0` or
a `git fetch origin <target>`. See
[GitHub Actions](guides/ci/github-actions.md) and [GitLab](guides/ci/gitlab.md).

### The session brief is empty, but CI has evidence

Evidence lives where `probe` ran and is gitignored. Point `status` and `brief`
at the document CI produced with `--evidence <file>`; `init --ci-evidence github`
writes a helper that downloads it. See
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
private source code; the [known-answer fixture](../fixtures/known-answer/README.md)
is a neutral place to reproduce a problem.

## Next

- [FAQ](faq.md)
- [Verdicts](reference/verdicts.md)
- [CLI reference](reference/cli.md)
