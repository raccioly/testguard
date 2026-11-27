# Replay: would this suite have caught the bugs that already escaped?

An injected fault is a fault that somebody thought of. A bug that actually
shipped is ground truth. A human already confirmed it was a defect, so there is
no equivalent-mutant argument to have about it. `replay` puts real escaped bugs
back into the code, one at a time. It asks whether the tests that existed
noticed. This guide is for a post-mortem, for a team that decides how much to
trust its suite, and for anyone who reads a calibration document.

## Run it

```bash
npx testguard-cli replay . --since HEAD~50..HEAD --max 10   # the last 50 commits, at most 10 fixes
npx testguard-cli replay . --since v1.4.0..HEAD             # everything since a release
```

`--since` is required and takes any range that `git log` accepts. A single ref
such as a tag means every commit reachable from it, not the commits after it.
For the commits after it, use `<tag>..HEAD`.

**`replay` reports and never gates.** It exits `0` whenever it completes,
whatever it found. A bug that escaped is history, not a regression in this
change, and a gate on history is a gate nobody can pass. It exits `2` when
it cannot read the range or the range holds no fix commit. It exits `3`
without `--since`.

## How fix commits are chosen

A **fix commit** is a non-merge commit in the range that changes source
**and** a test together. That pairing is the signal that a human confirmed a
defect. Someone changed behavior and shipped a test for it.

- Source is a `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` or
  `.py` file that is not a test.
- A test is a `*.test.*` or `*.spec.*` file, a Python test file
  (`test*.py`, `*_test.py`), or anything under a `test/`, `tests/` or
  `__tests__/` directory.
- Files the commit deleted are ignored.
- In a [monorepo](monorepo.md), only files inside the replayed project count.
  A commit whose source-and-test pair lies in another package is skipped.

**One patch counts once.** A dual-branch topology carries the same fix under
two or three shas. Counting it twice corrupts the corpus that the calibration
uses. `git patch-id --stable` removes duplicate candidates. The summary says
how many it dropped.

`--max <n>` keeps the first n unique fixes, newest first. It defaults to `20`
because each fix costs a scratch worktree and N test runs.

## What happens to each fix

`replay` works in a scratch git worktree, at the fix commit. It never touches
your tree. For each fix, it does these steps:

1. **Revert only the source** to the fix's parent. Remove a source file that
   the fix added, because it did not exist before.
2. **Delete the test files the fix shipped**, whole. That test proves nothing
   about what the suite knew before the test existed.
3. **Find the remaining tests that could notice**: the test files that import
   a reverted source file. Replay resolves them the same way as probe's
   defender discovery (JavaScript imports and aliases, Python module names).
4. **Run them N times** (`--confirm`, default `3`) and classify the result.

| Verdict | Meaning |
|---|---|
| `caught` | a remaining test failed by assertion, in every run. The suite knew. |
| `blind` | the suite stayed green on code known to be broken. |
| `nocover` | no test imports the reverted files. This is worse than blind. |
| `flaky` | the runs disagreed, so you can conclude nothing. A flaky failure looks like detection, which biases this metric *optimistically*. Mixed runs are never `caught`. |
| `unverifiable` | the measurement failed; the reason says how. |

The `unverifiable` reasons:

| Reason | What happened |
|---|---|
| `no-prior-version` | every source file is new in this commit. The commit adds behavior and does not correct it, so there was nothing to be blind to |
| `revert-did-not-apply` | the source could not be put back to the parent |
| `the-fix-shipped-the-only-test-file` | deleting the fix's test files left no test at all. Deleting a whole file can remove older tests with it. It would be wrong to charge the project a miss for evidence that the method destroyed |
| `defender-discovery-indeterminate` | replay could not resolve an import safely, so it cannot claim that "no test imports this" |
| `suite-failed-to-load` | the remaining tests did not load |
| `timed-out` | a run exceeded `--budget` |
| `failed-without-an-assertion` | every run failed, but not by an assertion |

Output from a small history with two `fix:` commits:

```
BLIND         762e404c4 other                1 test ran  fix: clamp negative values to zero

2 commits replayed from 2 candidates: 1 blind, 1 caught.
1 of 2 escaped bugs were invisible to the suite (1 blind, 0 with no test at all) — the escaped-bug miss rate is 50%.
  corpus: the 2 fix:/revert: commits of 2 measurable (fix 2).
A bug that reached production is by construction one the suite missed, so a high rate is expected on a first run. The number to move is this one, over time.

  other                  missed   1/2    p=0.50  ci [0.09, 0.91]

replay: …/.testguard/replay.json
calibration: …/.testguard/calibration.json
```

Every fix that was not caught gets a line. Replay only counts caught fixes.

## Fault classes: the join key

Replay gives each replayed bug the label of the injected-fault class that its
diff most resembles. It reads only the fix's **source** diff. A test diff
describes what the test asserted, not what was broken. A fix adds what the bug
lacked, so added lines weigh twice as much as removed ones.

| Label | The fix mostly… |
|---|---|
| `literal-changed` | changed a security or limit literal (`httpOnly`, `secure`, `sameSite`, rounds, cost, TTL, timeout, tolerance, window, limit, `maxAge`, `expiresIn`) |
| `call-removed` | added a `verify…` / `validate…` / `check…` / `assert…` / `authorize…` / `ensure…` / `require…` call |
| `exception-swallowed` | added a `catch` or a `throw` |
| `field-dropped` | added an object field |
| `guard-removed` | added an `if (…)` guard |
| `return-altered` | changed a `return` |
| `statement-deleted` | added an assignment |
| `other` | none of these shapes |

When two shapes score the same, the more specific one wins, in the order of
this table. An honest `other` is worth more than a confident wrong label. The
label is the join key. It turns a mutation score that you cannot interpret into
a statement with a sample size: "when a real bug of this class escapes, how
often does the suite miss it?"

## Reading the calibration

`replay` writes two documents: `.testguard/replay.json` (or `--out`) and
`calibration.json` beside it. `init` gitignores both. Each run regenerates
them.

```json
{
  "method": "wilson",
  "confidence": 0.95,
  "measures": "escape-missed",
  "bucketBy": "faultClass",
  "source": {
    "kind": "bug-replay",
    "ref": "HEAD~3..HEAD",
    "caveat": "measured on the 2 fix:/revert: commits in this range, of 2 replayed: every one is a bug that escaped, so a first run is expected to be high — the number to move is this one, over time",
    "detail": { "candidateRule": "conventional-fix", "replayed": 2, "selected": 2, "byType": { "fix": 2 } }
  },
  "buckets": {
    "other": { "n": 2, "positives": 1, "breakdown": { "caught": 1, "blind": 1 }, "p": 0.5, "ci": [0.0945, 0.9055] }
  }
}
```

- **`p` is a miss rate**: the share of escaped bugs of that class that the
  suite did not catch (`positives / n`). A high `p` is bad.
- **`ci` is the 95% Wilson score interval** around `p`. With `n = 2`, it spans
  most of the range. That is why replay prints it. Do not quote a `p`
  without its `n` and `ci`.
- **Which verdicts count.** `caught`, `blind` and `nocover` are measurements
  and enter the ratio. `nocover` counts as a miss. If you left it out, a
  project with no tests for a subsystem would score *better* than one with weak
  tests. `flaky` and `unverifiable` are failed measurements. They enter neither
  side.
- **Which commits count** is recorded in `source.detail.candidateRule`. Say
  most replayed subjects use conventional-commit types. Then the rule is
  `conventional-fix`, and only `fix:` and `revert:` commits enter the
  calibration. A reverted feature is not an escaped bug. A conventional
  repository with no `fix:` in range gives an empty calibration and a message
  to widen the range. It never falls back to counting features. Otherwise the
  rule is `source-and-test`, and every measured commit counts, because you
  cannot tell a fix from a feature. Two calibrations that use different
  rules are different populations. Do not merge them.
- **`caveat`** is the sentence to show beside any number you quote.

You can recompute every `p` and `ci` from `n` and `positives`, and the spec's
validator recomputes them. The schema is
[`spec/schemas/calibration.schema.json`](../../spec/schemas/calibration.schema.json).

Expect a high number on a first run. Every replayed bug is, by construction,
one that the suite missed. The number to move is this one, over time.

## The open question this exists to answer

Does a calibration learned on a repository *with* history transfer to a
greenfield one that has none? AI-authored code has no history, so replay
cannot help it directly. Calibration is the only bridge. That transfer is
unproven. It is the core product bet. `replay` is the tool for testing it,
not the answer.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--since <range>` | required | the commit range to search for fix commits |
| `--max <n>` | `20` | replay at most n unique fixes, newest first |
| `--confirm <n>` | `3` | runs per verdict; mixed runs are never `caught` |
| `--budget <ms>` | `120000` | wall clock per test run |
| `--command-budget <ms>` | none | deadline for the whole replay; on expiry it writes neither document, so an unmeasured suffix cannot look clean |
| `--workers <n>` / `--serial` | `1` | runner worker ceiling, as for `probe` |
| `--runner <name>` | `auto` | the project runner, as for `probe` |
| `--runner-cmd "<cmd>"` | none | a custom runner command; see [Languages and runners](../reference/languages-and-runners.md#custom-runners) |
| `--test-glob <glob>` | none | repeatable; needs `--runner-cmd`. Tests the built-in globs do not list join the replay universe. A test in a language other than JavaScript, TypeScript or Python is never run, because `replay` relates a test to the reverted source by its imports |
| `--node-modules <dir>` | auto-linked | the `node_modules` to link into each scratch worktree (or `TESTGUARD_NODE_MODULES`) |
| `--python <interpreter>` | discovered | the interpreter for Python defenders (or `TESTGUARD_PYTHON`), as for `probe`; see [Python](python.md#which-interpreter) |
| `--out <path>` | `.testguard/replay.json` | the replay document; the calibration is written beside it |
| `--json` | off | print `{ replay, calibration, paths }` instead of the summary |

Replay is slow because it uses one worktree and N runs per fix. Start with a
small `--max`. See [Performance](performance.md) for budgets.

## Next

- [Verdicts](../reference/verdicts.md) — replay verdicts beside probe's
- [Artifacts](../reference/artifacts.md) — `replay.json`, `calibration.json` and which files to commit
- [How it works](../concepts/how-it-works.md) — injected faults, and why replay is their ground truth
- [Performance](performance.md) — budgets for long replays
