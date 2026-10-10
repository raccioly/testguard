# Glossary

The terms TestGuard's commands, documents and output use, in alphabetical
order. Each entry is a sentence or two and links to the page that explains it
properly. Read [How TestGuard works](concepts/how-it-works.md) first if the
model is new to you.

## admit

The command that applies the [two-gate rule](#two-gate-rule) to one test
file: `ADMITTED` if it is green on unmodified `HEAD` and fails on every fault
of the claim, N out of N. See [Writing claims](guides/writing-claims.md#admit-the-two-gate-rule).

## anchor

A fault's `find` text, which must occur in its file exactly `expectHits`
times. A missing or ambiguous anchor makes the fault `UNVERIFIABLE`;
`claims --check-anchors` finds one before a probe does. See
[Writing claims](guides/writing-claims.md#anchors-rot-check-them-cheaply).

## baseline

The frozen fingerprints of today's unproven findings, in
`.testguard/baseline.json`, so later probes gate only on what is new. It is
committed. See [How it works](concepts/how-it-works.md#baseline-gate-only-the-delta).

## blast radius

How many non-test source files import a fault's target. One of the ranking
factors. See [How it works](concepts/how-it-works.md#ranking-never-a-score).

## brief

The ranked, capped `## TEST BLINDSPOT CONTEXT` block an agent reads at session
start, naming the next action and where the suite is blind. See
[How it works](concepts/how-it-works.md#brief-tell-the-agent-first).

## calibration

A per-[fault class](#fault-class) miss rate, with a confidence interval and
sample size, measured by [replay](#replay) on real fix commits. Whether a
calibration transfers between repositories is unproven. See
[replay](guides/replay.md).

## claim

A promise the project makes, stated in a sentence a reviewer can judge, with
its origin, severity and at least one [fault](#fault). Claims live in
`testguard.claims.json`. See [Writing claims](guides/writing-claims.md).

## concern

One sentence naming a *kind* of promise and where to look for it, used to aim
a [sweep](#sweep) across many files. A concern is never a claim. See
[Writing claims](guides/writing-claims.md#concerns).

## defender

A test file that supposedly protects a claim, named in `defendedBy` or found
by [discovery](#discovery). See [Writing claims](guides/writing-claims.md#defenders).

## discovery

Choosing defenders automatically: the test files that import a fault's
target, minus those that mock it. Used when `defendedBy` is absent or `[]`.
See [Writing claims](guides/writing-claims.md#discovery-and-why-mocks-do-not-count).

## escalation

Re-running a survivor against the whole suite, up to N times, to find tests
that catch it but are not declared defenders. A test is named only if it failed
in every run. See [How it works](concepts/how-it-works.md#what-a-probe-does).

## evidence

The validated record of a probe: one verdict per fault with every run behind
it and the input hashes, in `.testguard/evidence.json`. It is regenerated, not
committed. See [artifacts](reference/artifacts.md).

## fault

One deterministic `find`/`replace` edit in one file that would make a claim
false. See [Writing claims](guides/writing-claims.md#faults).

## fault class

The shape of a fault's break (`condition-forced`, `field-dropped`,
`literal-changed`, …). Required on every fault; it is the join key for
[calibration](#calibration). See [Writing claims](guides/writing-claims.md#faults).

## fingerprint

The hash of a finding's claim id, fault id, file and verdict, never its
`find`/`replace` text. Baselines store fingerprints. See
[`GATE-SEMANTICS.md`](../spec/GATE-SEMANTICS.md#baseline-and-delta).

## gate

The command that fails when a changed source file carries no claim and no
excusing ignore entry. More loosely, any exit code CI acts on. See
[How it works](concepts/how-it-works.md#gate-every-change-needs-a-claim).

## independence

Whether a killing test was last touched by the same change or author as the
code it guards: `co-authored`, `separate-change` or `unknown`. A signal that
ranking reads and verdicts never do (maturity level L3). See
[How it works](concepts/how-it-works.md#independence-l3).

## killed

The only passing [verdict](#verdict): a test failed by assertion in every
run with the fault applied, after a green baseline.

## negative control

On a would-be survivor, the target file is replaced with something that
cannot compile. If the defenders stay green they never run it, and the result
is `UNVERIFIABLE`, not `SURVIVED`. See
[How it works](concepts/how-it-works.md#what-a-probe-does).

## oracle supply

The cost of someone stating what must be true: the real bottleneck in
adoption. `scaffold`, `sweep` and concerns exist to lower it. See
[How it works](concepts/how-it-works.md#oracle-supply-scaffold-sweep-and-concerns).

## origin

Where a claim's intent came from, declared in `source.kind` (`spec`, `adr`,
`bug`, `incident`, …, `inferred`). A label, not authenticated independence.
See [Writing claims](guides/writing-claims.md#source-kinds).

## producer

Who or what wrote a claim or fault, in `producedBy.producer`: `human`,
`agent`, `operator` or `derived`. Separate from [origin](#origin). The
mechanical heuristics `scaffold` and `sweep` use to propose faults are also
called producers.

## provisional

Evidence from fewer than three confirmation runs (`--confirm 1`). Verdicts
print with `?`, go to `.testguard/evidence-provisional.json`, and cannot be
baselined.

## replay

The command that reverts real fix commits, removes the test each fix shipped,
and asks whether the remaining suite would have caught the bug. It reports and
never gates. See [replay](guides/replay.md).

## scratch worktree

The throwaway git worktree a probe applies faults in, so your working tree,
`HEAD` and index are never touched. See
[How it works](concepts/how-it-works.md#isolation-and-a-dirty-working-tree).

## signal

A static fact about a defender recorded on the evidence, such as
`mocked-never-asserted`. It informs ranking and the reader; it never changes a
verdict. See [verdicts](reference/verdicts.md).

## SURVIVED

The fault was applied and every defender stayed green: a blind spot. It is the
fault that survived, not the test. See [verdicts](reference/verdicts.md).

## sweep

The command that proposes faults for unclaimed changed files (or a concern's
scope), probes a bounded selection, and reports what no test noticed, without
writing any claim. See [Writing claims](guides/writing-claims.md#sweep-no-claim-needed).

## two-gate rule

A test counts only if it passes on unmodified `HEAD` *and* fails on every
fault of its claim. `admit` checks both. See
[AI agents](guides/ai-agents.md#the-two-gate-rule).

## verdict

The closed set of probe outcomes: `killed`, `SURVIVED`, `NOCOVER`,
`UNVERIFIABLE`, `FAULT-INVALID`, `TIMEOUT`, `FLAKY-DEFENDER`. Only `killed`
passes. See [verdicts](reference/verdicts.md).

## verdict reuse

Keeping a prior verdict instead of re-probing, allowed only when every
recorded input still matches, including the fault's own `find`/`replace` hash.
`--no-reuse` forces a fresh probe. See
[How it works](concepts/how-it-works.md#never-optimistic).

## Next

- [How TestGuard works](concepts/how-it-works.md)
- [Writing claims](guides/writing-claims.md)
- [Verdicts](reference/verdicts.md)
