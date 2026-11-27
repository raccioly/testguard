# Glossary

These are the terms that TestGuard's commands, documents and output use, in
alphabetical order. Each entry is a sentence or two. It links to the page that
explains the term in full. If the model is new to you, read
[How TestGuard works](concepts/how-it-works.md) first.

## admit

The command that applies the [two-gate rule](#two-gate-rule) to one test
file. The file is `ADMITTED` if it is green on unmodified `HEAD` and fails on
every fault of the claim, N out of N. See [Writing claims](guides/writing-claims.md#admit-the-two-gate-rule).

## anchor

A fault's `find` text. It must occur in its file exactly `expectHits`
times. A missing or ambiguous anchor makes the fault `UNVERIFIABLE`.
`claims --check-anchors` finds a bad anchor before a probe does. See
[Writing claims](guides/writing-claims.md#anchors-rot-check-them-cheaply).

## baseline

The frozen fingerprints of today's unproven findings, in
`.testguard/baseline.json`. Later probes gate only on what is new. You commit
this file. See [How it works](concepts/how-it-works.md#baseline-gate-only-the-delta).

## blast radius

The number of non-test source files that import a fault's target. It is one
of the ranking factors. See [How it works](concepts/how-it-works.md#ranking-never-a-score).

## brief

The ranked, capped `## TEST BLINDSPOT CONTEXT` block that an agent reads at
session start. It names the next action and where the suite is blind. See
[How it works](concepts/how-it-works.md#brief-tell-the-agent-first).

## calibration

A miss rate for each [fault class](#fault-class), with a confidence interval
and sample size. [Replay](#replay) measures it on real fix commits. Whether a
calibration transfers between repositories is unproven. See
[replay](guides/replay.md).

## claim

A promise the project makes, stated in a sentence a reviewer can judge. A
claim has an origin, a severity and at least one [fault](#fault). Claims live
in `testguard.claims.json`. See [Writing claims](guides/writing-claims.md).

## concern

One sentence that names a *kind* of promise and where to look for it. A
concern aims a [sweep](#sweep) across many files. A concern is never a claim.
See [Writing claims](guides/writing-claims.md#concerns).

## defender

A test file that supposedly protects a claim. You name it in `defendedBy`, or
[discovery](#discovery) finds it. See [Writing claims](guides/writing-claims.md#defenders).

## discovery

The automatic choice of defenders: the test files that import a fault's
target, minus those that mock it. TestGuard uses discovery when `defendedBy`
is absent or `[]`. See [Writing claims](guides/writing-claims.md#discovery-and-why-mocks-do-not-count).

## escalation

Re-running a survivor against the whole suite, up to N times. This finds tests
that catch the fault but are not declared defenders. TestGuard names a test
only if it failed in every run. See [How it works](concepts/how-it-works.md#what-a-probe-does).

## evidence

The validated record of a probe. It holds one verdict per fault, every run
behind each verdict, and the input hashes. It lives in
`.testguard/evidence.json`. TestGuard regenerates it, and you do not commit
it. See [artifacts](reference/artifacts.md).

## fault

One deterministic `find`/`replace` edit in one file that would make a claim
false. See [Writing claims](guides/writing-claims.md#faults).

## fault class

The shape of a fault's break (`condition-forced`, `field-dropped`,
`literal-changed`, …). Every fault needs one. It is the join key for
[calibration](#calibration). See [Writing claims](guides/writing-claims.md#faults).

## fingerprint

The hash of a finding's claim id, fault id, file and verdict. It never
includes the `find`/`replace` text. Baselines store fingerprints. See
[`GATE-SEMANTICS.md`](../spec/GATE-SEMANTICS.md#baseline-and-delta).

## gate

The command that fails when a changed source file has no claim and no
ignore entry that excuses it. More loosely, a gate is any exit code that CI
acts on. See [How it works](concepts/how-it-works.md#gate-every-change-needs-a-claim).

## independence

Whether a killing test was last touched by the same change or author as the
code it guards. The values are `co-authored`, `separate-change` and `unknown`.
Ranking reads this signal. Verdicts never read it (maturity level L3). See
[How it works](concepts/how-it-works.md#independence-l3).

## killed

The only passing [verdict](#verdict). A test failed by assertion in every
run with the fault applied, after a green baseline.

## negative control

A check on a would-be survivor. TestGuard replaces the target file with code
that cannot compile. If the defenders stay green, they never run the file. The
verdict is then `UNVERIFIABLE`, not `SURVIVED`. See
[How it works](concepts/how-it-works.md#what-a-probe-does).

## oracle supply

The cost of someone stating what must be true. This is the real bottleneck in
adoption. `scaffold`, `sweep` and concerns exist to lower it. See
[How it works](concepts/how-it-works.md#oracle-supply-scaffold-sweep-and-concerns).

## origin

Where a claim's intent came from. You declare it in `source.kind` (`spec`,
`adr`, `bug`, `incident`, …, `inferred`). It is a label. It does not prove
independence. See [Writing claims](guides/writing-claims.md#source-kinds).

## producer

Who or what wrote a claim or fault, in `producedBy.producer`: `human`,
`agent`, `operator` or `derived`. It is separate from [origin](#origin). The
mechanical heuristics that `scaffold` and `sweep` use to propose faults are
also called producers.

## provisional

Evidence from fewer than three confirmation runs (`--confirm 1`). Verdicts
print with `?` and go to `.testguard/evidence-provisional.json`. You cannot
baseline them.

## replay

The command that reverts real fix commits and removes the test each fix
shipped. It then asks whether the remaining suite would have caught the bug.
It reports and never gates. See [replay](guides/replay.md).

## scratch worktree

The throwaway git worktree where a probe applies faults. Your working tree,
`HEAD` and index are never touched. See
[How it works](concepts/how-it-works.md#isolation-and-a-dirty-working-tree).

## signal

A static fact about a defender, recorded on the evidence, such as
`mocked-never-asserted`. It informs ranking and the reader. It never changes a
verdict. See [verdicts](reference/verdicts.md).

## SURVIVED

The fault was applied and every defender stayed green. This is a blind spot.
The fault survived, not the test. See [verdicts](reference/verdicts.md).

## sweep

The command that proposes faults for unclaimed changed files (or a concern's
scope) and probes a bounded selection. It reports what no test noticed. It
writes no claim. See [Writing claims](guides/writing-claims.md#sweep-no-claim-needed).

## two-gate rule

A test counts only if it passes on unmodified `HEAD` *and* fails on every
fault of its claim. `admit` checks both. See
[AI agents](guides/ai-agents.md#the-two-gate-rule).

## verdict

The closed set of probe outcomes: `killed`, `SURVIVED`, `NOCOVER`,
`UNVERIFIABLE`, `FAULT-INVALID`, `TIMEOUT`, `FLAKY-DEFENDER`. Only `killed`
passes. See [verdicts](reference/verdicts.md).

## verdict reuse

Keeping a prior verdict instead of re-probing. TestGuard allows this only
when every recorded input still matches, including the hash of the fault's own
`find`/`replace`. `--no-reuse` forces a fresh probe. See
[How it works](concepts/how-it-works.md#never-optimistic).

## Next

- [How TestGuard works](concepts/how-it-works.md)
- [Writing claims](guides/writing-claims.md)
- [Verdicts](reference/verdicts.md)
