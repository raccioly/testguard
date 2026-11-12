# Performance

A probe runs real tests many times. This page says which command to run, what
it costs, and what to do when it is slow.

## Which command

| Situation | Command | Why |
|---|---|---|
| You changed code and want to know if your tests still defend it | `testguard probe --changed auto` | Probes only the claims the change can affect. The base is found offline: the CI base branch, the remote default branch, a differently named upstream, then the branch's own upstream (the commits not pushed yet). With no base it probes every claim, never nothing. |
| You are writing one test | `testguard probe --claim <ID> --confirm 1` | One claim, one confirmation run: fast and **provisional** (`?`). Confirm with `testguard admit <test-file> --claim <ID>` before committing. |
| Pre-push hook | `testguard probe --changed auto` | What `testguard init` writes. The full probe does not belong in a hook. |
| Pull request in CI | `testguard probe --changed auto`, with `.testguard/evidence.json` cached | Only the change is measured; unchanged verdicts are carried forward. `testguard init --ci github` or `--ci gitlab` writes this. |
| Nightly, or when asked | `testguard probe` | Every claim. The only run that refreshes everything, for example after a TestGuard upgrade. |
| A suite that cannot share the machine | `testguard probe --serial` | One test process at a time. Rarely needed: see [parallel safety](#probe-several-faults-at-once). |

What the defaults already do:

- **Faults run in parallel.** `--fault-workers auto` probes `min(4, floor(CPUs / 2))` faults at once (one on a machine with fewer than four CPUs), halved when other test runners are already busy. Override with `--fault-workers <n>` or `TESTGUARD_FAULT_WORKERS`.
- **Every kill is confirmed by a run alone.** A suite that shares a port, a database or a temp path across trees cannot turn into false kills (see [below](#probe-several-faults-at-once)).
- **Unchanged verdicts are reused** after one live baseline run per defender set, and a `--claim` or `--changed` run also reuses the last full probe.
- **`status` and `brief` say when you are leaving speed on the table** (`advice`), each line with the command to run.

## Measured

Measured for the 0.24 change (#270). Fault workers were 2 in every row: the
CI runner has 4 CPUs, and the 18-CPU workstation had other test runners busy,
so the automatic width halved itself from 4. "Guard" is the time spent on
confirmation runs taken alone after the fan-out (`run.measurements.aloneConfirmMs`).

This repository's self-probe (666 faults, almost all killed, unit and acceptance defenders):

| Run | Machine and load | Before (one fault at a time) | Now (default) | Speedup | Guard |
|---|---|---|---|---|---|
| From scratch | GitHub-hosted runner, 4 CPUs, idle | ≈ 3640 s (estimated: 3303 normalized s for 604 faults, `testguard.cost-budget.json`, scaled to 666) | 1626 s (1807 normalized) | ≈ 2.0× | 607 s (37%) |
| From scratch | workstation, 18 CPUs, load average 22–60 | not run | 4597 s | — | 1613 s (35%) |
| No change since the last probe | workstation, 18 CPUs, load average 40 | — | 454 s: 663 reused after 215 live baselines, measured side by side | — | 0 s |

A project of cheap unit tests (`node bench/cheap-units.mjs`: 24 vitest modules, 72 faults, every fault killed):

| Run | Machine and load | Wall time | Runner invocations | Guard |
|---|---|---|---|---|
| From scratch, `--serial` (the 0.23 behavior) | workstation, 18 CPUs, load average 22 | 126.5 s | 288 | — |
| From scratch, default | same | 79.1 s (1.6×) | 288 | 71 confirmations, 32.0 s |
| No change since the last probe | same | 6.5 s | 24 | — |
| `--changed HEAD~1` after touching one module | same | 5.9 s | 12 | 2 confirmations, 0.9 s |

A CPU-bound `node:test` project on the CI runner (the native-performance job,
3 fault workers, medians of five interleaved rounds against one fault at a
time): 0.52× the serial time with the guard, 0.40× before it.

What the guard costs: every kill measured beside another fault takes its last
run alone, one after another, after the fan-out. That run replaces a run, so
the number of runs does not change, but those runs are not parallel. On a suite
where almost every fault is killed, they are a third of the wall time. Every
kill still rests on a run with nothing else in flight, and that is what the
time buys. For a nightly job the absolute numbers matter less than the
pre-push and pull-request paths, which `--changed auto` and verdict reuse keep
to seconds.

## Why is this slow?

Work down this list; each item names how to check it.

1. **An old version.** `testguard --version`. Before 0.24 every fault ran one at a time. Upgrade, then run `testguard init --upgrade` ([upgrading](../upgrade.md)).
2. **`--serial` in a hook or CI.** It forces one fault at a time. `testguard status` prints an `advice` line when the last probe ran serially on a machine with room; `testguard init` lists every hook and CI line that passes it. Drop it.
3. **A full probe on every push.** Use `testguard probe --changed auto` in the hook and the pull request job, and keep `testguard probe` for the nightly job. `testguard init --upgrade` rewrites the hooks it wrote.
4. **No evidence cache in CI.** Without `.testguard/evidence.json` from the last run nothing is reused. Cache it (the CI files `init --ci` writes do).
5. **Expensive defender files.** `testguard probe --cost` (or `testguard claims --cost` after the fact) lists the slowest claims, faults and defender files. Split a slow file, or point a claim at a unit test; see [fix a shared defender](#fix-a-shared-defender).
6. **Python import time.** Every run starts an interpreter and imports the project. Move heavy imports out of module scope in tests, and keep `conftest.py` light.
7. **Many claims on one slow test file.** Every fault of every claim that names it runs the whole file N times. Give each claim the narrowest defender that still kills its faults (fault-level `defendedBy`).
8. **A suite that is not parallel-safe.** The probe warns `defender set … is not parallel-safe` and names the files. Their faults are then measured one at a time. Make those tests hermetic to get the parallelism back: every runner process gets `TESTGUARD_WORKER` (the 0-based tree index), so a dev server can listen on `8787 + Number(process.env.TESTGUARD_WORKER ?? 0)`. If that cannot be done, declare the claim `"serial": true` in the claims file: its faults are probed alone without the detection having to find out first.

## What a probe costs

For every fault, a probe runs the fault's selected defenders N times on
unmodified source (the baseline), then N times with the fault applied, where
N is `--confirm` (default `3`). A survivor costs more: one negative-control
run that proves the defenders execute the file at all, then up to N runs of
the **whole test universe** to find an undeclared test that catches it
(escalation). Roughly, the fresh work is

```
fresh baseline runs × defender-set cost
+ Σ (fault confirmations × that fault's defender-set cost)
+ survivor diagnostics and setup/discovery work
```

Some work is shared. The baseline is paid once per distinct defender set,
not once per fault, and the negative control once per target file and
defender set. A run stops early once its outcome is settled: escalation stops
as soon as no test has failed in every run, because from there none can be
named a killer.

So one slow acceptance test selected by several faults can be executed many
times. The symptom is a gate that takes twenty minutes; the cause is which
defender set each fault selects.

## See where the time goes

```bash
npx testguard-cli claims . --cost     # read back from the last probe's evidence
npx testguard-cli probe . --cost      # what the run you just made spent
```

Every number is read back out of the `durationMs` the probe already records.
`--cost` re-measures nothing, spawns nothing, and costs the price of reading
one JSON file. Output from
[`fixtures/known-answer-node`](../../fixtures/known-answer-node/README.md),
shortened:

```
actual elapsed 2.2s; fresh runners 1.5s across 25 invocations; setup/discovery/other overhead …
10 fault records cost 2.0s across 35 defender runs.

most expensive claims
    345ms  NODE-ALLOW                         1 fault  · 6 runs
    345ms  NODE-REACH                         1 fault  · 6 runs
    …

most expensive faults
    345ms  NODE-ALLOW/F1 · 6 runs · claim · test/policy.test.mjs
    …
      0ms  NODE-UNUSED/F1 · 0 runs · discovery · no defenders

defender files, by the time of the runs that included them
  (a fault runs its selected defender set at once, so these overlap and do not sum to the total)
     1.6s  test/policy.test.mjs                         6 claims
    325ms  test/mixed.test.mjs                          1 claim
    160ms  test/flaky.test.mjs                          1 claim

shared defenders — each fault selects the file; durations include recorded baseline sharing
     1.6s  test/policy.test.mjs
           named by NODE-ALLOW/F1, NODE-ANCHOR/F1, NODE-ANCHOR/F2, NODE-AUDIT/F1, NODE-REACH/F1, NODE-READY/F1, NODE-SYNTAX/F1
```

How to read it:

- **The first line is measured time** for this run: wall clock, fresh runner
  time and everything else. Evidence written before this breakdown existed
  has no first line.
- **Record costs are historical and attributed.** A reused verdict keeps the
  cost of the run that produced it, so the record total can exceed the
  elapsed time.
- **Each fault line names its selection origin** — `claim` (the claim's
  `defendedBy`), `fault` (the fault's own `defendedBy`) or `discovery` — and
  its selected defenders.
- **Per-file figures overlap.** A run executes a fault's whole defender set at
  once, so the runner never says how much of it belonged to which file. A
  file's figure is the time of every run that *included* it: an upper bound on
  what removing it could save, which is the decision you are making. Only the
  total is additive.
- **Sharing counts distinct faults**, including siblings within one claim.
  Repeated confirmation runs of one fault are not sharing.

## Fix a shared defender

Extract the decision the slow test proves into a pure function, unit-test
that, and point the claim at the unit test. This is not a testing trick: a
rule you can state in three lines should not need a fifty-second acceptance
test to falsify it.

Then **re-probe the claim** and read the verdict. When the extraction is
right, the claim still fails on the fault (`killed`). When it is wrong, the
claim `SURVIVED`, and the probe tells you so before you ship a weaker gate.
Never narrow `defendedBy` and assume; `claims` warns when a fault's defender
set narrows after a kill.

A fault can also select its own defenders: a unit-level fault can name
`["test/unit.test.mjs"]` while an integration fault inherits the claim's
broader set. [Writing claims](writing-claims.md) covers fault-level
`defendedBy`.

## Watch a probe that is still running

A probe used to print its stage line only when stderr was a terminal, so CI, a
redirected log and an agent harness saw nothing at all for the whole run.
Rewriting a line in place is a rendering choice, not a reason to withhold the
information:

| `--progress` | What you get |
|---|---|
| `auto` (default) | `tty` at a terminal, `plain` everywhere else |
| `tty` | one line, rewritten in place, for a human watching |
| `plain` | one append-only line per stage, for a log file, CI or an agent |
| `ndjson` | one JSON object per line: stages **and** verdicts as they land |
| `none` | silence |

```bash
npx testguard-cli probe . > probe.log 2>&1                   # plain lines, not twenty silent minutes
npx testguard-cli probe . --progress ndjson 2>events.ndjson  # machine-readable stream
```

`plain` writes one line per run of each stage:

```
  … NODE-FLAKY/F1 baseline 1/3
  … NODE-FLAKY/F1 baseline-flake 2/3
  … NODE-REACH/F1 negative-control 1/1
```

`ndjson` writes the same stages plus a verdict event per fault:

```
{"event":"stage","claim":"REDACT-001","fault":"F1","stage":"baseline","run":1,"of":3,"at":"…"}
{"event":"verdict","claim":"REDACT-001","fault":"F1","verdict":"survived","severity":"critical","file":"demo/redact.py","at":"…"}
```

The stages are `reuse-baseline` (the one live run that licenses carrying a
verdict forward), `baseline`, `baseline-flake` (finishing the baseline runs after
a red one, so "failed once in three" can be told from "fails every time"),
`probe`, `negative-control` and `escalation`. A verdict reused from earlier
evidence carries `"reused": true`.

**Progress always goes to stderr**, so `--json` leaves stdout as one document
and nothing else. `--quiet` and `--json` imply `none`; an explicit
`--progress` overrides both, because an operator who asks for a stream of
events has said what they want. `--progress` belongs to `probe`; `replay`
shows a rewritten stage line at a terminal only.

## Keep the machine responsive

**Workers.** Built-in runners default to one worker in `probe`, `sweep`,
`replay` and `admit`, which already means one test file at a time.
`--workers 2` raises the ceiling for Vitest, Jest, Playwright and Node's test
runner; `--serial` forces one whatever `--workers` says and also probes one
fault at a time. Python is always one worker. Faults run in parallel by default
(below); the runner groups of a mixed-runner defender set always run one after
another. [Languages and
runners](../reference/languages-and-runners.md#runner-summary) shows the flag
each runner receives.

**Probe several faults at once.** <a id="probe-several-faults-at-once"></a>
Almost all of a probe's time is spent inside the test runner. By default
(`--fault-workers auto`) a probe runs `min(4, floor(CPUs / 2))` faults at
once, each in its own scratch worktree. `--fault-workers <n>`,
`TESTGUARD_FAULT_WORKERS` or `--serial` (one fault at a time) override it, and
the evidence records which (`run.faultWorkersSource`, and `run.cpus` for auto).

- Baselines are measured once per defender set; different sets run side by
  side, and one that is not green beside another is measured again alone
  (`detail.baselineRemeasuredSerially`).
- **Every kill rests on a run alone.** A fault whose runs were all kills
  measured beside other faults takes its last run again later, in a tree of
  its own, with nothing else running (`probeRuns[].alone`). That costs no
  extra run, only the concurrency of those last runs
  (`run.measurements.aloneConfirmRuns`, `aloneConfirmMs`).
- **Disagreement is not flakiness.** If a run alone passes where runs beside
  other faults failed, the failure was the neighbors': the fault is measured
  again alone, in full, and its defender set is **not parallel-safe** for the
  rest of the run (`detail.notParallelSafe`, and a warning naming its files).
  Every kill in that set is then measured alone. A set whose baseline failed
  beside other sets and passed alone is probed alone from the start.
- A `TIMEOUT`, an inconsistent probe, a suite that failed to load, or an
  undeclared-killer attribution measured beside other faults is measured
  again alone before it is reported (`detail.remeasuredSerially`). A fan-out
  that keeps hitting that path costs time, not honesty; lower n or keep
  `--budget` close to what a healthy run needs.
- Each tree is one more checkout on disk (`node_modules` is linked, not
  copied). `--in-place` has one tree, so it probes one fault at a time.
- A fan-out's evidence is reused by a fan-out of any width, so a laptop and
  CI share it. It is never reused by a run that asked for one fault at a time.
- Two probes of the same repository at once are safe: scratch-worktree
  creation and removal take turns on a lock keyed by the repository (kept in
  the temp or scratch directory, never inside the repository).

**Contention.** Before the first run, the probe looks for test runners already
running on the machine (Vitest, Jest, Playwright, Mocha, AVA, Karma, Cypress)
other than its own. A contended machine turns a slow suite into a `TIMEOUT` or
`FLAKY-DEFENDER` verdict about the load, not the claim, so the probe warns and
records the detection in the evidence (`run.contention`). Wait for the other
run to finish before trusting a timeout. The warning's advice follows the run:
a run already at one test process says to wait; a run that raised `--workers`
is told to lower it or pass `--serial`; a `--runner-cmd` is told that its
concurrency is the command's own; a fan-out is told to lower `--fault-workers`
first. An automatic width is halved when the check finds other runners.

**Budgets.**

| Flag | Bounds | When it runs out |
|---|---|---|
| `--budget <ms>` (default `120000`, at least `1000`) | each runner invocation | the runner's process tree is killed and the run is a timeout, never a kill |
| `--command-budget <ms>` (at least `1000`) | the whole `probe`, `sweep`, `replay` or `admit` | the command exits `2` and writes no partial result, so an unattempted suffix cannot look clean |

`--command-budget` is cooperative: every child gets no more than the
remaining time, and every stage and write boundary checks the deadline.
Synchronous setup can overrun it slightly, because JavaScript cannot preempt
it.

**Cancellation.** Ctrl-C (or `SIGTERM`/`SIGHUP`) kills the runners TestGuard
started, then restores applied faults, then removes scratch worktrees (every
one, under `--fault-workers`), and exits `130`. A daemon a test started that has already re-parented itself is
outside that guarantee.

**This is not a sandbox.** A custom `--runner-cmd`, browser subprocesses,
native library threads and processes your tests create are not contained by
the worker setting. Use an OS or container boundary for untrusted or
daemonising commands. No amount of runner output counts as an assertion
failure or a detection.

## Reuse verdicts instead of recomputing them

A probe reuses a fault's previous verdict when nothing it depended on has
changed. All of these must match the evidence at the output path:

- the fault itself (its content hash) and the claim's metadata;
- the target file's hash and every selected defender's hash;
- everything the target and the defenders import, transitively, inside the
  project (`inputs.dependencyHashes`), plus the lockfiles, `package.json`,
  `pyproject.toml` and runner/compiler config at the project root. Python
  closures include every `conftest.py` above each file. When an import cannot
  be followed — a computed `import(name)`, `require(x)` or
  `importlib.import_module(name)`, a relative import that resolves to no file —
  the closure is `indeterminate` and that fault is probed every time;
- the requested and resolved defender sets and where they came from;
- the test universe and the discovery inputs. For built-in runners this
  binds the runner, its version and the hashes of its config files,
  `package.json`, workspace files, lockfiles and `tsconfig.json`. For a
  `--runner-cmd` it binds the test files and the command itself (its parsed
  words, hashed; reformatting whitespace is not a change);
- the runner the evidence records (`run.runner`): the engine that ran, its
  version, and where it was resolved from (`project`, `path`, `builtin`);
- `--confirm` and the worker policy (`--workers`, `--serial`; a fan-out of
  any width stands in for another, never for a run that asked for one fault at
  a time).

Then one more check that no hash can make: the defender set runs once on
unmodified source. Green, and every fault it defends is reused; red, and each
is probed in full. That run is the first run of the shared baseline, so it
costs one run per defender set, never one per fault, and
`run.measurements.reuseBaselineRuns` counts it. Evidence written before this
rule has no `dependencyHashes` and is probed again once.

A record produced by a probe error is never reused, and neither is one whose
defenders failed to load (`defenders-failed-to-load`): that is a statement
about the environment — a broken command, a missing dependency, a virtualenv
without the test requirements — and fixing it changes none of the hashed
inputs. Reused verdicts print `(reused)`. `--no-reuse` re-probes everything.

Reuse reads the previous document at the path this run will write: a
provisional run `evidence-provisional.json`, a full run `evidence.json`, or
whatever `--out` names. A `--claim` or `--changed` run reads
`.testguard/evidence-partial.json` **and** the canonical `evidence.json`,
each under the same rules, and where both hold a fault the later one wins. A cold run, a changed runner config or a changed worker policy probes
from scratch even when your source has not changed.

One kind of change reuse cannot see: anything outside the hashed inputs that
changes a verdict while the defenders stay green, such as an environment
variable, a package upgraded inside the same virtualenv, or a service your
tests read, a `setupFiles`/`globalSetup` file the runner config names by
string, or a lockfile above the project directory in a monorepo. A change that
turns the defenders red is caught by the live run.
Pass `--no-reuse` after one that does not.

In CI, restore the previous run's evidence from a cache and write to the same
path, so only claims whose inputs changed are probed again. TestGuard's own CI
does this; see [GitHub Actions](ci/github-actions.md).

## A fast loop while you iterate

Escalation re-runs the whole suite up to N times per survivor, which is the
expensive part of a first pass. While you work on one claim:

```bash
npx testguard-cli probe . --claim AUTH-ADMIN --no-escalate --include-dirty --confirm 1   # fast, provisional
npx testguard-cli probe . --claim AUTH-ADMIN --include-dirty                             # confirmed, with escalation
npx testguard-cli probe . --changed auto                                                 # everything your change can affect
npx testguard-cli probe .                                                                # the full pass: nightly, or when asked
```

- `--claim` takes one or more IDs (`--claim A,B --claim C`) and writes
  `.testguard/evidence-partial.json`, never the canonical file. The summary
  names both the requested and the probed count, so a green subset cannot pass
  for the whole selection.
- `--include-dirty` probes a snapshot of your working tree, so uncommitted
  tests count. `--in-place` is the alternative when the worktree cannot see
  your dependencies.
- `--confirm 1` (anything below 3) is **provisional**: verdicts print with a
  `?`, evidence goes to `.testguard/evidence-provisional.json`, and `baseline`
  refuses to freeze it unless you pass `--allow-provisional`.
- By default the stream lists only unproven faults plus a killed count;
  `--verbose` lists every fault.

## Next

- [Upgrading](../upgrade.md) — `testguard init --upgrade` and staying current
- [Languages and runners](../reference/languages-and-runners.md) — what each runner receives for `--workers` and `--serial`
- [GitHub Actions](ci/github-actions.md) — caching evidence so CI reuses verdicts
- [Verdicts](../reference/verdicts.md) — `TIMEOUT`, `FLAKY-DEFENDER` and why a hang is not a detection
- [CLI reference](../reference/cli.md) — every probe flag
