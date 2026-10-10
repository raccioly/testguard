# Performance

A probe runs real tests many times, so it takes minutes, and a gate nobody
can tell from a hang is a gate people start killing. This guide is for anyone
whose probe is slow, whose CI log is silent, or whose laptop stops responding
during a probe: what a probe spends, how to see it, how to bound it, and how
to make it cheaper without weakening it.

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

The stages are `baseline`, `baseline-flake` (finishing the baseline runs after
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
runner; `--serial` forces one whatever `--workers` says, so it only changes a
run that also raised `--workers`. Python is always serial. Faults run one after another, and so do the runner groups of a
mixed-runner defender set. [Languages and
runners](../reference/languages-and-runners.md#runner-summary) shows the flag
each runner receives.

**Contention.** Before the first run, the probe looks for test runners already
running on the machine (Vitest, Jest, Playwright, Mocha, AVA, Karma, Cypress)
other than its own. A contended machine turns a slow suite into a `TIMEOUT` or
`FLAKY-DEFENDER` verdict about the load, not the claim, so the probe warns and
records the detection in the evidence (`run.contention`). Wait for the other
run to finish before trusting a timeout. The warning's advice follows the run:
a default run is already one file at a time, so it says to wait; a run that
raised `--workers` is told to lower it or pass `--serial`; a `--runner-cmd` is
told that its concurrency is the command's own.

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
started, then restores applied faults, then removes scratch worktrees, and
exits `130`. A daemon a test started that has already re-parented itself is
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
- the requested and resolved defender sets and where they came from;
- the test universe and the discovery inputs. For built-in runners this
  binds the runner, its version and the hashes of its config files,
  `package.json`, workspace files, lockfiles and `tsconfig.json`. For a
  `--runner-cmd` it binds the test files and the command itself (its parsed
  words, hashed; reformatting whitespace is not a change);
- the runner the evidence records (`run.runner`): the engine that ran, its
  version, and where it was resolved from (`project`, `path`, `builtin`);
- `--confirm` and the worker policy (`--workers`, `--serial`).

A record produced by a probe error is never reused, and neither is one whose
defenders failed to load (`defenders-failed-to-load`): that is a statement
about the environment — a broken command, a missing dependency, a virtualenv
without the test requirements — and fixing it changes none of the hashed
inputs. Reused verdicts print `(reused)`. `--no-reuse` re-probes everything.

Reuse reads the previous document at the path this run will write: a
`--claim` run reuses `.testguard/evidence-partial.json`, a provisional run
`evidence-provisional.json`, a full run `evidence.json`, or whatever `--out`
names. A cold run, a changed runner config or a changed worker policy probes
from scratch even when your source has not changed.

One kind of change reuse cannot see: anything outside the hashed inputs that
changes a verdict without breaking the load, such as an environment variable,
a package upgraded inside the same virtualenv, or a service your tests read.
Pass `--no-reuse` after one.

In CI, restore the previous run's evidence from a cache and write to the same
path, so only claims whose inputs changed are probed again. TestGuard's own CI
does this; see [GitHub Actions](ci/github-actions.md).

## A fast loop while you iterate

Escalation re-runs the whole suite up to N times per survivor, which is the
expensive part of a first pass. While you work on one claim:

```bash
npx testguard-cli probe . --claim AUTH-ADMIN --no-escalate --include-dirty --confirm 1   # fast, provisional
npx testguard-cli probe . --claim AUTH-ADMIN --include-dirty                             # confirmed, with escalation
npx testguard-cli probe .                                                                # the final pass, defaults
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

- [Languages and runners](../reference/languages-and-runners.md) — what each runner receives for `--workers` and `--serial`
- [GitHub Actions](ci/github-actions.md) — caching evidence so CI reuses verdicts
- [Verdicts](../reference/verdicts.md) — `TIMEOUT`, `FLAKY-DEFENDER` and why a hang is not a detection
- [CLI reference](../reference/cli.md) — every probe flag
