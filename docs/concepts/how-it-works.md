# How TestGuard works

This page explains the model behind every TestGuard command. It covers what a
claim, a fault and a defender are, what a probe does to your code, why
TestGuard never rounds a result toward green, and how the parts form one loop.
Read it once before you adopt the tool, or when a verdict surprises you. For
flags, see [the CLI reference](../reference/cli.md). For what each verdict
means, see [verdicts](../reference/verdicts.md).

## The question

Coverage tells you that a line ran. It does not tell you whether anything
checked the result. TestGuard asks a narrower question: **if this specific
promise were false, would a test fail?**

TestGuard answers by breaking the code on purpose. A *fault* is a deterministic
edit that makes one stated promise false. TestGuard applies the fault and runs
the tests that are supposed to defend that promise. Then it records what
happened:

- **killed**: a test failed by assertion, in every run. The promise is defended.
- **SURVIVED**: everything stayed green while the promise was false. This is a blind spot.

It is the *fault* that survived, not the test. SURVIVED is bad news. A healthy
report is full of `killed`. There are seven verdicts in total. "Did the suite
go red?" is not a good enough question, because a hang, a load failure or a
flaky run is not a detection. [Verdicts](../reference/verdicts.md) lists the
closed set.

## The loop

TestGuard uses one loop, and the other Guard tools use the same loop:

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

- **Oracle supply.** `scaffold`, `sweep` and concerns propose faults. A human
  then has something concrete to turn into a claim. The bottleneck is rarely
  verification. The bottleneck is that someone must state what must be true.
- **Calibration.** `replay` runs real fix commits against the suite again. It
  measures how often bugs of each fault class escape. It reports and never
  gates.

`status` covers all of it. It reads the claims, the evidence, the baseline and
the working tree. It names the state of the project and the one next action.
Every human-readable output (CLI text, the brief, the agent skill) comes from
that one document, so they cannot disagree.

## Claims, faults and defenders

A **claim** is a promise that the project makes, in a sentence that a reviewer
can judge: *"A caller without the admin role is refused."* It records where
that intent came from (`source.kind`: a spec, an ADR, a bug, an incident…). It
records how bad it is if false (`severity`). It records who wrote it
(`producedBy`).

A **fault** is one concrete way that the claim could be false. You write it as
an exact string substitution in one file: `find` this text, `replace` it with
that text. It carries a `faultClass` (`condition-forced`, `field-dropped`,
`literal-changed`…) so that you can later calibrate findings by class. A claim
has at least one fault. The `replace` strings run under your test runner, so
the claims file is code. Review it like code.

A **defender** is a test file that supposedly protects the claim. You name the
defenders in `defendedBy`. If you leave `defendedBy` out, TestGuard
**discovers** them. Discovery finds the test files that import the target of
the fault, by relative path or resolved alias, *minus the files that mock it*.
A test that `vi.mock`s or `jest.mock`s a module cannot detect a fault inside
that module. If TestGuard counted such a test, it would hide a `NOCOVER`.

[Writing claims](../guides/writing-claims.md) explains how to write all three.

## What a probe does

For each fault, in order:

1. **Green baseline.** Run the defenders N times (default 3) on unmodified
   code. If they are not green every time, the verdict is `FLAKY-DEFENDER` and
   TestGuard applies no fault. A suite that fails on clean code cannot tell
   you whether it notices broken code.
2. **Apply the fault** in a scratch worktree. The anchor must match exactly
   `expectHits` times (default 1), or the verdict is `UNVERIFIABLE`. TestGuard
   never guesses a new location.
3. **Run the defenders N times** with the fault applied. N assertion failures
   mean `killed`. N passes mean a candidate survivor. Any mixed result means
   `FLAKY-DEFENDER`. A load error is `FAULT-INVALID`. A hang is `TIMEOUT`.
4. **Negative control**, on a candidate survivor only. Replace the target file
   with something that cannot compile. If the defenders still pass, they never
   run that file. The record then becomes `UNVERIFIABLE`
   (`subject-not-executed`). Without this step, the record would be a survivor
   that looks like an audit finding and is false.
5. **Escalation**, on a confirmed survivor. Run the whole suite with the fault
   applied, up to N times. This finds tests that catch the fault but are not
   declared defenders. TestGuard names a test only if it failed in every run.
   So escalation stops as soon as no test has failed in all runs so far. A
   survivor that tests catch this way stays `SURVIVED` with the reason
   `killed-by-undeclared-tests`. The fix is to add those files to
   `defendedBy`. `--no-escalate` skips this step.
6. **Restore and classify.** TestGuard removes the fault. It writes the
   verdict, every run behind it, and the input hashes to the evidence. It
   validates the evidence against
   [`evidence.schema.json`](../../spec/schemas/evidence.schema.json) before it
   writes it.

`--confirm 1` makes a fast **provisional** pass. Verdicts print with `?`. The
evidence goes to `.testguard/evidence-provisional.json`. `baseline` refuses
that evidence.

## Isolation and a dirty working tree

By default, a probe runs in a **scratch worktree** that TestGuard creates from
a commit. The probe never touches your working tree, `HEAD` or index. But a
worktree probes a *commit*. Uncommitted edits to a defender or a target are not
in it. If you probe the implicit `HEAD` while such edits exist, the probe
silently ignores your new test. It reports the same survivors and gives no hint
why. So `probe` refuses and names the files.

| You want to probe | Use | What happens |
|---|---|---|
| `HEAD` with a clean tree | `probe` | scratch worktree at `HEAD` |
| your working tree, uncommitted tests included | `probe --include-dirty` | TestGuard snapshots tracked edits and new files into a throwaway commit and probes that commit |
| a specific commit (a pre-fix commit in a post-mortem, say) | `probe --ref <commit>` | TestGuard honors it over a dirty tree. A warning names the dirty files, and the evidence records them as `repo.ignoredDirty` |
| `HEAD` as committed, knowingly | `probe --ignore-dirty` | same warning and record as `--ref` |
| the working tree itself | `probe --in-place` | TestGuard applies faults to your files and restores them. Only fault *target* files must be clean. Test files may be dirty |

You cannot combine `--include-dirty` with `--ref` or `--in-place`. Every
summary names the commit that it probed. If the scratch worktree cannot see
your dependencies, pass `--node-modules <dir>`. `admit` always probes a
snapshot, because its whole job is to judge an uncommitted test.

## Never optimistic

One constraint drives the design: **a tool that reports everything as caught
is worse than no tool, because nobody questions good news.** So TestGuard
rounds every ambiguity toward *unproven*:

- It runs three times instead of once, and it checks for a green baseline
  before it applies any fault.
- It reports a timeout, a load failure, a mixed N-run result, a flaky defender
  or a missing anchor as unproven, never as a kill.
- An unbounded or ambiguous import resolution is `UNVERIFIABLE`, never a
  flattering `NOCOVER`.
- It reuses a verdict only when its recorded inputs still match: the hashes of
  the target and defender files, the test universe, the discovery inputs, the
  confirmation count and worker policy, and the `find`/`replace` hash of the
  fault. Otherwise it probes the fault again. `--no-reuse` forces a new probe.

`killed` is the only pass. Every other verdict gates by default. The exact
rules are in [`GATE-SEMANTICS.md`](../../spec/GATE-SEMANTICS.md).

## Ranking, never a score

There is no single number. TestGuard ranks findings so that the worst blind
spot comes first. It multiplies four factors:

- **severity** of the claim (`critical` weighs most);
- **declared origin**: a claim from a spec or ADR ranks above a claim from an
  annotation or a comment;
- **blast radius**: how many non-test source files import the target
  (TestGuard resolves relative imports, `tsconfig` path aliases and
  `package.json#imports`, but not bare package names);
- **independence** of the killing test, below.

Ranking orders findings. It never changes a verdict.

## Baseline: gate only the delta

`baseline` freezes the fingerprint of every non-passing finding. Later probes
suppress what is already known and exit non-zero only on what is new. TestGuard
derives a fingerprint from the claim id, the fault id, the file and the
verdict. It never uses the `find`/`replace` text. So when you repair a rotted
anchor, the baseline does not change, but a change of verdict does show up.

A baseline frozen from `--include-dirty` evidence points at the *parent* of the
commit that will carry your tests. After you commit, run a clean `probe` and
then `baseline --restamp`. This moves the baseline to that commit, and only
when the fingerprints are identical. [Artifacts](../reference/artifacts.md)
says which `.testguard/` files to commit.

## Brief: tell the agent first

`brief` turns the evidence and the baseline into a ranked, capped block. The
block opens with `## TEST BLINDSPOT CONTEXT`, names the next action, and lists
where the suite is blind. An agent reads it before it writes code, so the agent
knows which promises are undefended. `--text` prints only the block. The
session-start hook runs `--text`. `--markdown` renders the block as a
merge-request note for a human reviewer. [AI agents](../guides/ai-agents.md)
explains how to connect `brief` to an agent.

## Gate: every change needs a claim

`probe` can verify only claims that exist. A verifier with no claim about a
feature is silent about that feature. Every escaped defect in the field
reports so far was a **claim gap**: the feature shipped green with zero
claims. `gate` closes that gap on the delta:

```bash
npx testguard-cli gate --changed origin/main            # in a PR: files changed since the base branch
npx testguard-cli gate --changed HEAD --include-dirty   # before a commit: the working tree, staged or not
```

Every changed source file must meet one of three conditions. It carries a
fault. It is a declared or discovered defender of a claim (test files). Or an
unexpired `path` entry in `testguard.ignore.json`, with a reason, excuses it.
One unclaimed file makes the command exit `1`. There is no percentage. The gate
prints every ignore entry that it relied on, so a reviewer sees why the change
passed. Some files never carry claims (`*.d.ts`, `*.config.*`, fixtures,
mocks; `--explain` lists them). The gate excludes them and says so. `--strict`
fails a change that evaluated nothing.

TestGuard detects the base when Git records it. An explicit `--changed` wins.
Then come `TESTGUARD_CHANGED_REF`, GitHub Actions (`GITHUB_BASE_REF`) and
GitLab merge-request pipelines (`CI_MERGE_REQUEST_DIFF_BASE_SHA`, then
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`), in that order. On a feature branch in
an ordinary clone, bare `gate` uses the symbolic default branch of the remote
(normally `origin/main`) and says how it chose it. It never picks a same-name
tracking branch or the default branch itself, because either one could produce
an empty diff that misleads you. In those cases, pass `--changed`. CI setup is
in [GitHub Actions](../guides/ci/github-actions.md) and
[GitLab](../guides/ci/gitlab.md).

`status --changed <ref>` reports `unclaimed-changes` before any evidence state.
So you write the claim before you write more code. In a monorepo, a nested
`testguard.claims.json` marks a separate project. The parent gate leaves the
files of that project to the nested gate. See [monorepos](../guides/monorepo.md).

## Oracle supply: scaffold, sweep and concerns

`gate` names the files that carry no claim and stops there, because stating a
claim is a human act. A project that adopts the tool reads that list and has
nothing to compare it against. Three steps lower the cost of the first
sentence:

- **`scaffold <file>`** proposes faults for one file from nine mechanical
  shapes (a forced guard, a removed call, a dropped field…). It writes them as
  a draft document, never to your claims file. Its claims are `TODO:`
  statements with `source.kind: inferred` until a human supplies the intent.
- **`sweep`** takes the unclaimed changed files and proposes faults with the
  same producers. It probes a bounded selection and reports what a green suite
  did not notice. A survivor is alarming even without a claim: something was
  broken on purpose and no test failed. `sweep` never writes
  `testguard.claims.json`. Its evidence goes to `.testguard/sweep-evidence.json`
  and never replaces `.testguard/evidence.json`. Only `survived` and `nocover`
  exit 1, so a proposal that would not compile never fails the run. The default
  cap is 7 faults per swept file. The faults are spread out, so one busy file
  cannot make the others look clean. The ordering learns from your own
  evidence: how often each fault class survives here, shrunk toward a shipped
  prior until you have enough records.
- **Concerns** name a *kind* of promise and where to look for it, such as
  "every admin route refuses a caller without the admin role". One sentence can
  then aim a sweep across many files. A concern is never a claim.

A sweep is weaker evidence than a probe, and says so: nobody stated that the
behavior mattered. The survivors worth defending become the first claims.
[Writing claims](../guides/writing-claims.md#from-proposal-to-claim-scaffold-sweep-and-concerns)
explains how to use all three.

## Replay: calibrating the fault model

An injected fault is a fault that somebody thought of. A bug that shipped is
ground truth. `replay` finds fix commits (source and test changed together),
reverts the source, and deletes the test that the fix shipped. Then it runs
what remains and asks: would the suite have caught the bug? `replay` labels
each replayed bug with the fault class that its diff most resembles. This turns
"SURVIVED" into a miss rate per class, with a sample size. It reports and never
gates. See [replay](../guides/replay.md).

## Independence (L3)

`probe` measures *power*: would this test notice if the code were wrong? On
every kill, it also records whether the same commit or the same author last
touched the killing test and the code that the test guards.
`detail.independence` is `co-authored`, `separate-change` or `unknown`.
`unknown` means there is no history, for example an uncommitted snapshot or a
shallow clone.

A co-authored kill is legitimate: a fix *should* ship with its regression test.
But a repository where every kill is co-authored has no independent
verification, whatever its verification rate says. Agents saturate the tests
that they can see ([SpecBench](https://arxiv.org/abs/2605.21384)). Independence
is a **signal**: ranking reads it, verdicts never do, and `probe`, `status` and
the brief each say it in one line:

```text
3 of 3 kills are co-authored with the code they defend — the test and the code were written in the same change, so those kills are not independent evidence.
```

## Gaming is visible

The cheapest way to make a survivor disappear is to weaken its fault instead of
writing a test. The evidence records the content hash of every fault. So
`status` lists any fault that someone edited after it survived, with its
previous verdict, under `changedFaults`. It makes a review of that edit the
next action. You may edit a claim, because claims can be wrong. But the edit is
never invisible.

Deleting a claim is cheaper still, and none of the above shows it: `probe`
verifies the claims that exist, and `status` says clean. So:

```bash
npx testguard-cli claims --since origin/main    # every claim and fault that existed there and does not now
```

`removed-claim` and `removed-fault` exit 1. A rename that keeps the statement
verbatim is reported as `renamed-claim` and does not exit 1. Where evidence
exists, the line names the last verdict of the claim. "It was SURVIVED when it
was removed" is the sentence that matters. You may remove a claim. A `claim` or
`fault` entry in `testguard.ignore.json`, with a reason, excuses the removal.
See [Writing claims](../guides/writing-claims.md#removing-or-renaming-a-claim).

`status` also reports the **claimed surface**. This is the number of claimed
source modules out of all source modules. It also shows how many of the 20
highest-churn modules (over the last 200 commits) carry a claim, and which
unclaimed modules to examine next. When most modules are unclaimed and the
existing evidence is clean, the next action is to widen the claimed surface. The
next action is not to praise the same few claims again.

## Properties

- **Deterministic measurement.** No model decides a verdict. Faults are string
  substitutions from a reviewed file. Verdicts come from the structured report
  of the runner, confirmed N times. The same inputs give the same evidence.
- **No network, no telemetry.** The CLI never opens a socket. The session-start
  hook only finds a binary that is already installed. Nothing leaves the
  machine, unless a CI job that you configured posts it.
- **Artifacts are data.** Claims, evidence, baseline and brief are JSON.
  TestGuard validates them against a published schema in
  [`spec/`](../../spec/README.md) before it writes them. Nothing is healed or
  re-targeted at run time.
- **Configured discovery is evidence.** Vitest, Jest and Playwright list their
  own configured test files. TestGuard hashes that universe instead of
  guessing with filename globs.
- **Per-run and whole-command time are separate.** `--budget` limits each
  runner invocation. `--command-budget` limits a whole measurement. When it
  expires, the command exits `2` and writes no partial result. See
  [performance](../guides/performance.md).

## How it differs from classic mutation testing

Breaking code to test the tests is mutation testing. It dates to the 1970s, and
Stryker, PIT, mutmut and Cosmic Ray do it well. They mutate everything
mechanically and report a score such as "73%". That score cannot tell you which
promise is at risk. TestGuard binds every fault to a **stated claim**. So the
output is a finding instead of a metric: *"your project says a missing role is
refused; nothing checks that."*

TestGuard borrows from two industrial programs. From Google
([Petrović et al., 2021](https://arxiv.org/abs/2102.11378)): mutate only
changed code, cap what you show per file, and order candidates by measured
productivity. These are the diff scope, the cap and the ordering of `sweep`.
From Meta ([Foster et al., FSE 2025](https://arxiv.org/abs/2501.12862)): the
*concern* as the unit that a human writes, and the rule that nothing proposed
reaches the claims file unless it passes a probe and a human decides to keep
it. Neither program binds a fault to a stated promise. The full record is in
[`docs-canonical/PRIOR-ART.md`](../../docs-canonical/PRIOR-ART.md). It includes
what TestGuard deliberately did not take, and why no model decides a verdict.

## What TestGuard is not

- **Not a test generator.** It judges a test that the agent wrote (`admit`).
  The agent does the generating.
- **Not a mutation-score dashboard.** There are no blanket mutants, no single
  score and no threshold. Faults are few and bound to stated claims. TestGuard
  ranks findings and never adds them up.
- **Not a self-healing runner.** A defender that adapts itself to a change did
  not observe the change. TestGuard reports that. It does not do it.
- **Not a coverage tool.** `NOCOVER` means that no test even imports the file.
  TestGuard measures everything above that by injecting the fault.

You never reach 100% of correctness. You can reach **100% of stated claims
verified**, and an assessor reads the statement of claims.

## Next

- [Writing claims](../guides/writing-claims.md): turn intent into claims, faults and defenders
- [Verdicts](../reference/verdicts.md): every verdict and signal, and the only acceptable fix for each
- [Using TestGuard with your AI agent](../guides/ai-agents.md): the operating loop an agent follows
- [Glossary](../glossary.md)
