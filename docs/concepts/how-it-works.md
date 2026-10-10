# How TestGuard works

This page explains the model behind every TestGuard command: what a claim, a
fault and a defender are, what a probe actually does to your code, why it
refuses to round anything toward green, and how the pieces form one loop. Read
it once before adopting the tool, or when a verdict surprises you. For flags,
see [the CLI reference](../reference/cli.md); for what each verdict means, see
[verdicts](../reference/verdicts.md).

## The question

Coverage tells you a line ran. It never tells you whether anything checked the
result. TestGuard asks a narrower, harder question: **if this specific promise
were false, would a test fail?**

It answers by breaking the code on purpose. A *fault* is a deterministic edit
that makes one stated promise false. TestGuard applies it, runs the tests that
are supposed to defend that promise, and records what happened:

- **killed**: a test failed by assertion, in every run. The promise is defended.
- **SURVIVED**: everything stayed green while the promise was false. A blind spot.

It is the *fault* that survived, not the test. SURVIVED is the bad news; a
healthy report is full of `killed`. Seven verdicts exist in total, because "did
the suite go red?" is a sloppy question: a hang, a load failure or a flaky run
is not a detection. The closed set is in [verdicts](../reference/verdicts.md).

## The loop

TestGuard shares one loop with the other Guard tools:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

| Step | Command | What it produces |
|---|---|---|
| Declare | edit `testguard.claims.json` | claims, each with one or more faults |
| Falsify | `probe` | `.testguard/evidence.json`: one verdict per fault |
| Freeze | `baseline` | `.testguard/baseline.json`: today's known findings |
| Gate | `probe` (new findings only), `gate --changed <ref>` (unclaimed files) | exit codes CI acts on |
| Brief | `brief` | the `## TEST BLINDSPOT CONTEXT` block an agent reads at session start |

Two side channels feed the loop:

- **Oracle supply.** `scaffold`, `sweep` and concerns propose faults so a human
  has something concrete to turn into a claim. The bottleneck is rarely
  verification; it is someone stating what must be true.
- **Calibration.** `replay` re-runs real fix commits against the suite to
  measure how often bugs of each fault class escape. It reports and never
  gates.

`status` sits over all of it: it reads the claims, evidence, baseline and
working tree and names the project's state and the one next action. Every
human rendering (CLI text, the brief, the agent skill) derives from that one
document, so they cannot disagree.

## Claims, faults and defenders

A **claim** is a promise the project makes, in a sentence a reviewer can judge:
*"A caller without the admin role is refused."* It records where that intent
came from (`source.kind`: a spec, an ADR, a bug, an incident…), how bad it is
if false (`severity`), and who wrote it (`producedBy`).

A **fault** is one concrete way the claim could be false, written as an exact
string substitution in one file: `find` this text, `replace` it with that. It
carries a `faultClass` (`condition-forced`, `field-dropped`,
`literal-changed`…) so findings can later be calibrated by class. A claim has
at least one fault. Because `replace` strings run under your test runner, the
claims file is code and is reviewed like code.

A **defender** is a test file that supposedly protects the claim. You name
them in `defendedBy`, or leave it out and TestGuard **discovers** them: the
test files that import the fault's target, by relative path or resolved alias,
*minus the files that mock it*. A test that `vi.mock`s or `jest.mock`s a module
cannot detect a fault inside it, so counting it would hide a `NOCOVER`.

How to write all three is in [Writing claims](../guides/writing-claims.md).

## What a probe does

For each fault, in order:

1. **Green baseline.** Run the defenders N times (default 3) on unmodified
   code. If they are not green every time, the verdict is `FLAKY-DEFENDER` and
   no fault is applied: a suite that fails on clean code cannot be asked
   whether it notices a broken one.
2. **Apply the fault** in a scratch git worktree. The anchor must match exactly
   `expectHits` times (default 1), or the verdict is `UNVERIFIABLE`. TestGuard
   never guesses a new location.
3. **Run the defenders N times** with the fault applied. N assertion failures
   is `killed`; N passes is a candidate survivor; anything mixed is
   `FLAKY-DEFENDER`. A load error is `FAULT-INVALID`; a hang is `TIMEOUT`.
4. **Negative control**, on a candidate survivor only. The target file is
   replaced with something that cannot compile. If the defenders still pass,
   they never execute that file, and the record becomes `UNVERIFIABLE`
   (`subject-not-executed`) instead of a survivor that reads as an audit
   finding while being false.
5. **Escalation**, on a confirmed survivor. The whole suite runs with the
   fault applied, up to N times, to find tests that catch it but are not
   declared defenders. A test is named only if it failed in every run, so it
   stops as soon as no test has failed in all runs so far. A survivor caught
   this way stays `SURVIVED` with reason `killed-by-undeclared-tests`: the fix
   is to add those files to `defendedBy`. `--no-escalate` skips this step.
6. **Restore and classify.** The fault is removed and the verdict, every run
   behind it, and the input hashes are written to the evidence, validated
   against [`evidence.schema.json`](../../spec/schemas/evidence.schema.json)
   before it is written.

`--confirm 1` makes a fast **provisional** pass: verdicts print with `?`, the
evidence goes to `.testguard/evidence-provisional.json`, and `baseline`
refuses it.

## Isolation and a dirty working tree

By default a probe runs in a **scratch git worktree** created from a commit.
Your working tree, `HEAD` and index are never touched. The catch is that a
worktree probes a *commit*: uncommitted edits to a defender or a target are not
in it. Probing the implicit `HEAD` with such edits present would silently
ignore your new test and report the same survivors with no hint why, so
`probe` refuses and names the files.

| You want to probe | Use | What happens |
|---|---|---|
| `HEAD` with a clean tree | `probe` | scratch worktree at `HEAD` |
| your working tree, uncommitted tests included | `probe --include-dirty` | tracked edits and new files are snapshotted into a throwaway commit, which is probed |
| a specific commit (a pre-fix commit in a post-mortem, say) | `probe --ref <commit>` | honoured over a dirty tree; a warning names the dirty files and the evidence records them as `repo.ignoredDirty` |
| `HEAD` as committed, knowingly | `probe --ignore-dirty` | same warning and record as `--ref` |
| the working tree itself | `probe --in-place` | faults are applied to your files and restored; only fault *target* files must be clean, test files may be dirty |

`--include-dirty` cannot be combined with `--ref` or `--in-place`. Every
summary names the commit it probed. If the scratch worktree cannot see your
dependencies, pass `--node-modules <dir>`. `admit` always probes a snapshot,
because judging an uncommitted test is its whole job.

## Never optimistic

The design follows from one constraint: **a tool that reports everything as
caught is worse than no tool, because nobody questions good news.** So every
ambiguity rounds toward *unproven*:

- three runs rather than one, and a green baseline before any fault;
- a timeout, a load failure, a mixed N-run result, a flaky defender or a
  missing anchor is reported as unproven, never as a kill;
- an unbounded or ambiguous import resolution is `UNVERIFIABLE`, never a
  flattering `NOCOVER`;
- a verdict is reused only when its recorded inputs still match: target and
  defender file hashes, the test universe, discovery inputs, the confirmation
  count and worker policy, and the fault's own `find`/`replace` hash. Otherwise
  the fault is probed again; `--no-reuse` forces it.

`killed` is the only pass. Every other verdict gates by default; the exact
rules are in [`GATE-SEMANTICS.md`](../../spec/GATE-SEMANTICS.md).

## Ranking, never a score

There is no single number. Findings are ranked so the worst blind spot comes
first, by four factors multiplied together:

- **severity** of the claim (`critical` weighs most);
- **declared origin**: a claim from a spec or ADR ranks above one from an
  annotation or a comment;
- **blast radius**: how many non-test source files import the target
  (relative imports, `tsconfig` path aliases and `package.json#imports` are
  resolved; bare package names are not);
- **independence** of the killing test, below.

Ranking orders findings. It never changes a verdict.

## Baseline: gate only the delta

`baseline` freezes the fingerprint of every non-passing finding. Later probes
suppress what was already known and exit non-zero only on what is new. A
fingerprint is derived from the claim id, fault id, file and verdict, never
from the `find`/`replace` text, so repairing a rotted anchor does not churn the
baseline while a change of verdict does surface.

A baseline frozen from `--include-dirty` evidence points at the *parent* of
the commit that will carry your tests. After you commit, a clean `probe` plus
`baseline --restamp` moves it to that commit, and only when the fingerprints
are identical. Which `.testguard/` files to commit is in
[artifacts](../reference/artifacts.md).

## Brief: tell the agent first

`brief` turns evidence and baseline into a ranked, capped block that opens with
`## TEST BLINDSPOT CONTEXT`, names the next action, and lists where the suite is
blind. An agent reads it before writing code, so it knows which promises are
undefended. `--text` prints it only, which is what the session-start hook runs;
`--markdown` renders it as a merge-request note for a human reviewer. Wiring it
into an agent is covered in [AI agents](../guides/ai-agents.md).

## Gate: every change needs a claim

`probe` can only verify claims that exist. A verifier with no claim about a
feature is silent about it by construction, and every escaped defect in the
field reports so far was a **claim gap**: the feature shipped green with zero
claims. `gate` closes that hole on the delta:

```bash
npx testguard-cli gate --changed origin/main            # in a PR: files changed since the base branch
npx testguard-cli gate --changed HEAD --include-dirty   # before a commit: the working tree, staged or not
```

Every changed source file must carry a fault, be a declared or discovered
defender of a claim (test files), or be excused by an unexpired `path` entry in
`testguard.ignore.json` with a reason. One unclaimed file exits `1`; there is
no percentage. Every ignore entry the gate relied on is printed, so a reviewer
sees why it passed. Files that never carry claims (`*.d.ts`, `*.config.*`,
fixtures, mocks; `--explain` lists them) are excluded and said so; `--strict`
fails a change that evaluated nothing.

The base is detected when Git records it: an explicit `--changed` wins, then
`TESTGUARD_CHANGED_REF`, then GitHub Actions (`GITHUB_BASE_REF`) and GitLab
merge-request pipelines (`CI_MERGE_REQUEST_DIFF_BASE_SHA`, then
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`). On a feature branch in an ordinary
clone, bare `gate` uses the remote's symbolic default branch (normally
`origin/main`) and says how it chose it; it never picks a same-name tracking
branch or the default branch itself, because either could produce a
misleadingly empty diff. In those cases pass `--changed`. CI setup is in
[GitHub Actions](../guides/ci/github-actions.md) and
[GitLab](../guides/ci/gitlab.md).

`status --changed <ref>` reports `unclaimed-changes` before any evidence state,
so the claim is written before more code. In a monorepo, a nested
`testguard.claims.json` marks a separate project whose files the parent gate
delegates; see [monorepos](../guides/monorepo.md).

## Oracle supply: scaffold, sweep and concerns

`gate` names the files that carry no claim and stops there, because stating a
claim is a human act. A project adopting the tool reads that list with nothing
to compare it against. Three rungs lower the cost of the first sentence:

- **`scaffold <file>`** proposes faults for one file from nine mechanical
  shapes (a forced guard, a removed call, a dropped field…) as a draft
  document, never your claims file. Its claims are `TODO:` statements with
  `source.kind: inferred` until a human supplies the intent.
- **`sweep`** takes the unclaimed changed files, proposes faults with the same
  producers, probes a bounded selection, and reports what a green suite did
  not notice. No claim is needed for a survivor to be alarming: something was
  broken deliberately and no test failed. It never writes
  `testguard.claims.json`, its evidence goes to `.testguard/sweep-evidence.json`
  and never replaces `.testguard/evidence.json`, and only `survived` and
  `nocover` exit 1, so a proposal that would not compile never fails the run.
  The default cap is 7 faults per swept file, spread so one busy file cannot
  make the others look clean, and the ordering
  learns from your own evidence: how often each fault class survives here,
  shrunk toward a shipped prior until you have enough records.
- **Concerns** name a *kind* of promise and where to look for it, such as
  "every admin route refuses a caller without the admin role", so one sentence
  can aim a sweep across many files. A concern is never a claim.

A sweep is weaker evidence than a probe, and says so: nobody stated that the
behaviour mattered. The survivors worth defending become the first claims.
Using all three is in [Writing claims](../guides/writing-claims.md#from-proposal-to-claim-scaffold-sweep-and-concerns).

## Replay: calibrating the fault model

An injected fault is a fault somebody thought of. A bug that shipped is ground
truth. `replay` finds fix commits (source and test changed together), reverts
the source, deletes the test the fix shipped, and runs what remains: would the
suite have caught it? Each replayed bug is labelled with the fault class its
diff most resembles, which turns "SURVIVED" into a miss rate per class with a
sample size. It reports and never gates. See [replay](../guides/replay.md).

## Independence (L3)

`probe` measures *power*: would this test notice if the code were wrong. On
every kill it also records whether the killing test was last touched by the
same commit or the same author as the code it guards. `detail.independence` is
`co-authored`, `separate-change` or `unknown` (no history, such as an
uncommitted snapshot or a shallow clone).

A co-authored kill is legitimate: a fix *should* ship with its regression test.
But a repository where every kill is co-authored has no independent
verification, whatever its verification rate says, and agents saturate the
tests they can see ([SpecBench](https://arxiv.org/abs/2605.21384)). It is a
**signal**: ranking reads it, verdicts never do, and `probe`, `status` and the
brief each say it in one line:

```text
3 of 3 kills are co-authored with the code they defend — the test and the code were written in the same change, so those kills are not independent evidence.
```

## Gaming is visible

The cheapest way to make a survivor disappear is to weaken its fault rather
than write a test. Evidence records every fault's content hash, so `status`
lists any fault edited after it survived, with its previous verdict, under
`changedFaults`, and makes reviewing that edit the next action. Editing a claim
is allowed, because claims can be wrong. It is never invisible.

Deleting a claim is cheaper still, and invisible to everything above: `probe`
verifies the claims that exist and `status` says clean. So:

```bash
npx testguard-cli claims --since origin/main    # every claim and fault that existed there and does not now
```

`removed-claim` and `removed-fault` exit 1; a rename that keeps the statement
verbatim is reported as `renamed-claim` and does not. Where evidence exists,
the line names the verdict the claim last had, because "it was SURVIVED when it
was removed" is the sentence that matters. Removal is allowed and is excused
by a `claim` or `fault` entry in `testguard.ignore.json` with a reason; see
[Writing claims](../guides/writing-claims.md#removing-or-renaming-a-claim).

`status` also reports the **claimed surface**: claimed source modules over all
source modules, how many of the 20 highest-churn modules (over the last 200
commits) carry a claim, and which unclaimed modules to examine next. When most
modules are unclaimed and the existing evidence is clean, the next action is to
expand the denominator rather than congratulate the same few claims again.

## Properties

- **Deterministic measurement.** No model decides a verdict. Faults are string
  substitutions from a reviewed file; verdicts come from the runner's
  structured report, confirmed N times. The same inputs give the same evidence.
- **No network, no telemetry.** The CLI never opens a socket, and the
  session-start hook only resolves a binary that is already installed. Nothing
  leaves the machine unless a CI job you configured posts it.
- **Artifacts are data.** Claims, evidence, baseline and brief are JSON
  validated against a published schema in [`spec/`](../../spec/README.md)
  before they are written. Nothing is healed or re-targeted at run time.
- **Configured discovery is evidence.** Vitest, Jest and Playwright enumerate
  their own configured test files; TestGuard hashes that universe rather than
  guessing with filename globs.
- **Per-run and whole-command time are separate.** `--budget` bounds each
  runner invocation; `--command-budget` bounds a whole measurement and, on
  expiry, exits `2` without writing a partial result. See
  [performance](../guides/performance.md).

## How it differs from classic mutation testing

Breaking code to test the tests is mutation testing, and it dates to the 1970s;
Stryker, PIT, mutmut and Cosmic Ray do it well. They mutate everything
mechanically and report a score such as "73%", which cannot tell you which
promise is at risk. TestGuard binds every fault to a **stated claim**, so the
output is a finding instead of a metric: *"your project says a missing role is
refused; nothing checks that."*

It borrows from two industrial programmes. From Google
([Petrović et al., 2021](https://arxiv.org/abs/2102.11378)): mutate only
changed code, cap what is surfaced per file, and order candidates by measured
productivity, which is `sweep`'s diff scope, cap and ordering. From Meta
([Foster et al., FSE 2025](https://arxiv.org/abs/2501.12862)): the *concern*
as the unit a human writes, and the rule that nothing proposed reaches the
claims file without passing a probe and a human keep. Neither binds a fault to
a stated promise. The full record, including what was deliberately not taken
and why no model decides a verdict, is in
[`docs-canonical/PRIOR-ART.md`](../../docs-canonical/PRIOR-ART.md).

## What TestGuard is not

- **Not a test generator.** It judges a test the agent wrote (`admit`); the
  generating half stays with the agent.
- **Not a mutation-score dashboard.** No blanket mutants, no single score, no
  threshold. Faults are few and bound to stated claims; findings are ranked,
  never summed.
- **Not a self-healing runner.** A defender that adapts itself to a change did
  not observe it. TestGuard reports that; it does not do it.
- **Not a coverage tool.** `NOCOVER` means no test even imports the file;
  everything above that is measured by injecting the fault.

You never reach 100% of correctness. You can reach **100% of stated claims
verified**, and the statement of claims is what an assessor reads.

## Next

- [Writing claims](../guides/writing-claims.md): turn intent into claims, faults and defenders
- [Verdicts](../reference/verdicts.md): every verdict and signal, and the only acceptable fix for each
- [Using TestGuard with your AI agent](../guides/ai-agents.md): the operating loop an agent follows
- [Glossary](../glossary.md)
