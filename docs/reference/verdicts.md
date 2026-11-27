# Verdicts and signals reference

This page lists every verdict, reason, signal and finding label that
TestGuard prints or records. It says what each one means and whether it fails
a run. Use it to read output: a probe log, an evidence file, a sweep report or
an `admit` answer. The official definitions are in
[`spec/GATE-SEMANTICS.md`](../../spec/GATE-SEMANTICS.md#verdicts). They include
the order in which the checks stop early. This page follows them.

One design rule sits behind all of it: **every ambiguity rounds toward
unproven.** TestGuard never reports these as a kill: a timeout, a load failure,
a mixed result across runs, a flaky defender or a missing anchor. A tool that
reports everything as caught is worse than none, because nobody questions good
news.

## Probe verdicts

`probe`, `admit` and `sweep` write these. The set is closed, and only one
value is a pass. Text output prints every verdict except `killed` in capitals.

| Verdict | Printed | Meaning | Gates |
|---|---|---|---|
| `killed` | `killed` | Every one of N probe runs failed in a test body, by an assertion or by an exception the fault caused. The defenders were green N/N on unmodified code. The claim is defended. `detail.killKind` says how (below). | no |
| `survived` | `SURVIVED` | Every one of N probe runs passed with the fault applied. A real blind spot. | yes |
| `nocover` | `NOCOVER` | No test defends the claim. Either the declared globs resolve to nothing, or no test file imports the target without mocking it. Nothing was tried. | yes |
| `unverifiable` | `UNVERIFIABLE` | TestGuard could not probe the fault. Its anchor moved or matches more than once, the defenders failed to load, discovery was indeterminate, or the defenders never execute the target. Nothing was learned. | yes |
| `fault-invalid` | `FAULT-INVALID` | The replacement does not load or compile, or (`--typecheck`) parses but does not type-check. This is a bad fault, not a finding about the tests. | yes |
| `timeout` | `TIMEOUT` | The defenders ran past `--budget` with the fault applied. A hang is not a detection. | yes |
| `flaky-defender` | `FLAKY-DEFENDER` | The defenders were not green N/N on unmodified code, or the N probe runs disagreed. Do not trust any verdict about the fault until you fix the defenders. | yes |

### How a fault was killed

A kill by an assertion proves the suite checks the behavior. A kill only by an
exception proves the suite **reaches** the code. The fault made the code
throw and a test went red, but nothing rejected a value. When an agent writes
the tests, this second kind is exactly the hollow test that should not count
as proof. So every `killed` record says which kind it was. The verdict does
not change.

| `detail.killKind` | Meaning |
|---|---|
| `assertion` | Every probe run had at least one assertion-classified failing test. |
| `exception-only` | No run had one. A test with no assertion went red because the code threw. |
| `mixed` | Some runs had one and some did not. |

The runner decides from structured error identity, never from message text.
Structured identity means an `AssertionError`, a matcher result, a failed
`expect` step or a Python exception type. An error the runner cannot read
counts as an exception. `expect(fn).not.toThrow()` and `assert.doesNotThrow`
are assertions.

`probe --require-assertion-kill` (and `admit`) turns the distinction into a
gate. Any `exception-only` kill fails the run with exit 1. So does a kill from
evidence that predates the field. The verdict stays `killed`. `status` and
`brief` count exception-only kills as a weakness, next to the co-authored
count. Rule 3 of the [gate semantics](../../spec/GATE-SEMANTICS.md) gives the
rule and its known limits.

"Gates" means the verdict fails `probe` (exit `1`) unless it is in the
baseline or its claim is below `--severity`. When a baseline exists, `probe`
tags each unproven record `[NEW]`, `[baseline]` or `[below floor]`.

### Reasons

`detail.reason` qualifies a verdict and is printed in brackets after it.

| Verdict | `detail.reason` | Meaning |
|---|---|---|
| `survived` | `killed-by-undeclared-tests` | The declared defenders missed the fault, but tests elsewhere in the suite failed in every escalation run. The verdict stays `survived`, because the stated evidence chain is broken. `detail.undeclaredKillers` names the tests (`file::name`) to add to `defendedBy`. |
| `unverifiable` | `anchor-missing` | `find` occurs zero times. `detail.anchor` has `hits` and `expected`. |
| `unverifiable` | `anchor-ambiguous` | `find` occurs a number of times other than `expectHits`. |
| `unverifiable` | `file-missing` | The fault's `file` does not exist. |
| `unverifiable` | `defenders-failed-to-load` | The defenders did not load on unmodified code. |
| `unverifiable` | `defender-discovery-indeterminate` | Automatic discovery could not safely resolve a candidate test file. Uncertainty never becomes `nocover`. |
| `unverifiable` | `subject-not-executed` | The negative control. The target was replaced with something that cannot compile, and the defenders stayed green. So they never execute the target. A survivor here would describe their reach, not their assertions. |
| `unverifiable` | `probe-error` | Probing this fault threw an error. `detail.message` names it. |
| `unverifiable` | `not-reached-within-budget` | `probe --partial-on-budget` only. The command budget ran out before this fault was fully measured (in flight, or never started). It has no runs and no resolved defenders, and TestGuard never reuses it. It gates, so the unmeasured rest cannot look clean. |
| `fault-invalid` | `replacement-does-not-compile` | The runner reported a parse or transform error. |
| `fault-invalid` | `suite-failed-to-load` | The suite failed to load for another reason. |
| `fault-invalid` | `replacement-does-not-typecheck` | `--typecheck`: the project's own type checker refuses the replacement. `detail.message` is the first diagnostic and `detail.typecheck` is `diagnostics`. No test ran (`baselineRuns` and `probeRuns` are empty). |
| `timeout` | `test-timed-out` | A probe run timed out. `detail.message` says three things. First, the run ended at the budget (with 5 s at most to kill its process tree). Second, whether TestGuard confirmed that teardown. Third, whether other test runners were busy on the machine. If they were, the timeout is an environment condition, and the verdict stays `timeout`. |
| `timeout` | `typecheck-timed-out` | `--typecheck`: the type check of this fault exceeded `--budget`. `detail.typecheck` is `timeout`. |
| `flaky-defender` | `defenders-not-green` | Not N/N green on unmodified code. `detail.flakeRate` says how often. |
| `flaky-defender` | `inconsistent-probe` | Some probe runs killed the fault and some did not. |

### Provisional verdicts

A run with `--confirm` below 3 is **provisional**. Provisional runs behave
like this:

- Every verdict prints with a trailing `?` (`SURVIVED?`, `killed?`).
- The summary starts with `PROVISIONAL:`.
- A warning prints on stderr.
- The evidence records `run.provisional: true` and goes to
  `.testguard/evidence-provisional.json`.
- `baseline` refuses to freeze it without `--allow-provisional`.

Provisional runs are for the fix loop: a fast signal while you write a test.
They are not for a gate.

### Record details

Fields on `detail` beyond `reason`. They describe how a verdict was reached;
none of them changes it.

| Field | On | Meaning |
|---|---|---|
| `baselineRuns`, `probeRuns` | every injected fault | Every run of the defenders, unmodified and with the fault applied. |
| `flakeRate` | every fault whose baseline runs ran | `{runs, failures}`: how many runs on unmodified code failed. Load errors and timeouts are excluded from both numbers. Any failure makes the verdict `flaky-defender`. |
| `independence` | `killed` | Whether the same change last touched the killing test and the code it guards. Values: `co-authored` (same commit, or the same author), `separate-change`, or `unknown` (no history: an untracked file, a shallow clone). Ranking uses it as a signal. A co-authored kill is legitimate. But a suite where every kill is co-authored has no independent verification. |
| `negativeControl` | would-be survivors | `reached` (the defenders went red when the target could not compile, so they do execute it) or `not-reached` (the verdict becomes `unverifiable`, `subject-not-executed`). |
| `targetNotImported` | Python | With the fault applied, no defender imported the target module at all. A fact about the tests' reach, not their assertions. A module imported from outside the tree being probed is not recorded here: that run is refused. |
| `escalated`, `escalationRuns` | survivors | The whole suite was re-run with the fault applied. |
| `escalationStoppedEarly` | survivors | `no-common-failure`: escalation stopped because no test had failed in every run so far. It can only fail to name a killer, never upgrade a verdict. |
| `undeclaredKillers` | `killed-by-undeclared-tests` | The tests that failed in every escalation run. |
| `anchor` | anchor reasons | `{hits, expected}`. |
| `restoreSkipped` | rare | `target-missing`: something outside the process deleted the target during the run. |
| `baselineRemeasuredSerially` | with `--fault-workers` above 1 | `true`: this defender set's baseline was not green N/N while another set's baseline was running. TestGuard measured it again alone, in a fresh scratch tree. `baselineRuns` are those serial runs. |
| `remeasuredSerially` | with `--fault-workers` above 1 | `true`: the record first came out `timeout` or `inconsistent-probe` while other faults were in flight. TestGuard measured it again alone, in a fresh scratch tree. The verdict comes from that serial measurement. |
| `message` | `probe-error` | The first line of what threw. |

## Defender signals

Static facts about the defenders, recorded in `defenders.signals` on the
evidence record and printed by `claims` and `probe`. **A signal never changes
a verdict.** It explains one, or points at the cheapest place to look.

| Signal | Printed | Meaning |
|---|---|---|
| `mocked-never-asserted` | `MOCKED-NEVER-ASSERTED` | A test file mocks the target module (`vi.mock`, `jest.mock`) and never asserts on anything imported from it. Field reports show this is the exact signature of an escaped bug. Silence it, visibly, with `// unasserted: <why>` (or `# unasserted: <why>` in Python) on or above the mock. |
| `unasserted-annotated` | `unasserted (annotated)` | The same, with the author's annotation recorded as `reason`. The signal is silenced, never hidden. |
| `target-attribute-patched` | `attribute-patched` | A Python defender patches individual attributes of the target (`patch("pkg.mod.fn")`) rather than the module. The file stays a defender, because a fault elsewhere in the module is still detectable. `reason` names the patched attributes, which are the places where the test is least likely to notice anything. |
| `persistence-payload-unasserted` | in the sweep report | A resolved defender mocks the persistence layer. It can prove the call shape, but never that a row landed. TestGuard attaches this signal only to a `survived` record whose fault sits on a write path. `reason` names the mocked layer and the file's assertion mix (exact, partial, argument-free). `counts` and `specifiers` carry the same data. |

The record has related defender fields:

`mocking` lists candidate test files that import the target but mock it. A
discovered file that mocks is excluded from `resolved`, because a mock cannot
detect a fault in what it replaced. `discovered: true` marks defenders found by
import rather than declared. `selectionSource` says where the selection came
from (`fault`, `claim` or `discovery`).

## Replay verdicts

`replay` writes these, one per fix commit. Replay reports and never gates. Its
exit code is `0` whatever these say.

| Verdict | Meaning | Enters calibration |
|---|---|---|
| `caught` | A remaining test failed by assertion on the reverted source, every run. The suite knew. | yes, as caught |
| `blind` | The suite stayed green on known-broken code. | yes, as a miss |
| `nocover` | No remaining test imports the reverted files. Worse than blind. | yes, as a miss |
| `flaky` | The runs disagreed (`runs-disagreed`). A flaky failure would look like detection, so mixed runs are never `caught`. | no |
| `unverifiable` | Nothing could be concluded. | no |

Counting `nocover` as a miss is deliberate. If replay left it out, a project
with no tests for a subsystem would score better than one with weak tests.

| `unverifiable` reason | Meaning |
|---|---|
| `revert-did-not-apply` | The source revert did not apply. |
| `suite-failed-to-load` | The remaining suite could not load. |
| `timed-out` | A run timed out. |
| `failed-without-an-assertion` | Every run failed, but not by assertion. |
| `the-fix-shipped-the-only-test-file` | Removing the fix's own test left nothing to run. |
| `no-prior-version` | The commit only adds source: there was no earlier behavior to be blind to. |
| `defender-discovery-indeterminate` | Discovery of the tests to run was indeterminate. |
| `no-runs` | Nothing ran. |

## Sweep

`sweep` records the same seven probe verdicts. But its faults are ones nobody
stated, so it gates on fewer verdicts.

| Verdict | Exit |
|---|---|
| `survived` | `1`: something was deliberately broken and no test failed. |
| `nocover` | `1`: no test imports the swept file. |
| `unverifiable`, `fault-invalid`, `timeout`, `flaky-defender` | reported, never gating. They describe a machine-made proposal, and people switch off a tool that fails because its own guess was bad. |
| `killed` | not listed as a finding. |

So `sweep` exits `0` when nothing survived and a test imports every swept
file. It exits `1` otherwise, `2` when it cannot evaluate, and `3` without a
reference. Presentational elements (icons, static wrappers) are set aside
before selection and counted. TestGuard never probes them. Faults beyond
`--cap` are reported as deferred. Neither case is a verdict.

## Admit

`admit` reduces the claim's records to one answer.

| Answer | Exit | When |
|---|---|---|
| `ADMITTED` | `0` | Every fault of the claim is `killed`, N/N, by defenders that are green N/N on unmodified HEAD. |
| `ADMITTED?` | `0` | The same at `--confirm` below 3. Provisional: confirm with `--confirm 3` before committing. |
| `NOT ADMITTED` | `1` | Anything else. It names the first blocking fault, in this order: `survived`, `nocover`, `unverifiable`, `fault-invalid`, `timeout`, `flaky-defender`. It also says what to do about it. |

`admit` refuses a test that is neither a declared nor a discovered defender of
the claim. It refuses before anything runs (exit `3`), because a kill would
then be the work of another test.

## Other findings

These labels are not verdicts, but they still affect an exit code or the next action.

| Label | From | Meaning | Exit effect |
|---|---|---|---|
| `UNDECLARED` | `claims` | A `@claim <ID>` annotation in source has no entry in the claims file. | `claims` exits `1` |
| `STALE` | `claims` | An annotation-sourced claim has no `@claim` annotation left in source. | `claims` exits `1` |
| `NARROWED-DEFENDERS` | `claims` | A fault now selects fewer defenders than it inherited, after a prior kill. The old kill does not prove the narrower set, so probe again. | none |
| `INVALID` | `status` | An exact anchor is missing or ambiguous. State `invalid-anchors`, next action `repair-fault`. | `status` exits `1` |
| `ANCHOR-MISSING`, `ANCHOR-AMBIGUOUS`, `FAULT-INVALID` | `claims --check-anchors` | The same anchor check, run on demand. `FAULT-INVALID` here means a JavaScript or Python replacement no longer parses. Nothing runs. | `claims` exits `1` |
| `CHANGED` | `status` | A fault's content changed since the last probe. If its last verdict was not `killed`, the state is `evidence-stale` and the next action is `review-fault-change`. Weakening a fault is the cheapest way to make a survivor disappear. | `status` exits `1` |
| `UNCLAIMED` | `gate` | A changed source file carries no claim and no excusing `path` ignore entry. | `gate` exits `1` |
| `EXPIRED` | `gate`, `claims --since` | An ignore entry past its `expires`. It excuses nothing. | none by itself |
| `delegated` | `gate` | Changed files that belong to a nested project; run `gate` there. | none here |
| `REMOVED` (`removed-claim`, `removed-fault`) | `claims --since` | A claim or fault that existed at the reference and does not now, with its last verdict where evidence exists. | `claims` exits `1` unless a `claim` or `fault` ignore entry excuses it |
| `renamed` (`renamed-claim`) | `claims --since` | A removed ID whose statement reappears verbatim under a new ID. | none |

## Next

- [Gate semantics](../../spec/GATE-SEMANTICS.md): the normative rules.
- [CLI reference](cli.md): each command's exit codes.
- [Writing claims](../guides/writing-claims.md): turning a `SURVIVED` into a test that kills it.
- [Replay guide](../guides/replay.md): reading a calibration.
