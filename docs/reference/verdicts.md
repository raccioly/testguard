# Verdicts and signals reference

Every verdict, reason, signal and finding label TestGuard prints or records,
what each one means, and whether it fails a run. This page is for reading
output: a probe log, an evidence file, a sweep report, an `admit` answer. The
normative definitions, including the order in which the checks short-circuit,
are in [`spec/GATE-SEMANTICS.md`](../../spec/GATE-SEMANTICS.md#verdicts); this
page follows it.

The one design rule behind all of it: **every ambiguity rounds toward
unproven.** A timeout, a load failure, a mixed result across runs, a flaky
defender or a missing anchor is never reported as a kill, because a tool that
reports everything as caught is worse than none: nobody questions good news.

## Probe verdicts

Written by `probe`, `admit` and `sweep`. The set is closed, and only one value
is a pass. Text output prints every verdict but `killed` in capitals.

| Verdict | Printed | Meaning | Gates |
|---|---|---|---|
| `killed` | `killed` | Every one of N probe runs failed with a genuine assertion failure, on defenders that were green N/N on unmodified code. The claim is defended. | no |
| `survived` | `SURVIVED` | Every one of N probe runs passed with the fault applied. A real blind spot. | yes |
| `nocover` | `NOCOVER` | No test defends the claim: the declared globs resolve to nothing, or no test file imports the target without mocking it. Nothing was even tried. | yes |
| `unverifiable` | `UNVERIFIABLE` | The fault could not be probed: its anchor moved or matches more than once, the defenders failed to load, discovery was indeterminate, or the defenders never execute the target. Nothing was learned. | yes |
| `fault-invalid` | `FAULT-INVALID` | The replacement does not load or compile. A bad fault, not a finding about the tests. | yes |
| `timeout` | `TIMEOUT` | The defenders exceeded `--budget` with the fault applied. A hang is not a detection. | yes |
| `flaky-defender` | `FLAKY-DEFENDER` | The defenders were not green N/N on unmodified code, or the N probe runs disagreed. No verdict about the fault can be trusted until the defenders are fixed. | yes |

"Gates" means the verdict fails `probe` (exit `1`) unless it is in the
baseline or its claim is below `--severity`. When a baseline exists, `probe`
tags each unproven record `[NEW]`, `[baseline]` or `[below floor]`.

### Reasons

`detail.reason` qualifies a verdict and is printed in brackets after it.

| Verdict | `detail.reason` | Meaning |
|---|---|---|
| `survived` | `killed-by-undeclared-tests` | The declared defenders missed it, but tests elsewhere in the suite failed in every escalation run. Still `survived`: the stated evidence chain is broken. `detail.undeclaredKillers` names the tests (`file::name`) to add to `defendedBy`. |
| `unverifiable` | `anchor-missing` | `find` occurs zero times. `detail.anchor` has `hits` and `expected`. |
| `unverifiable` | `anchor-ambiguous` | `find` occurs a number of times other than `expectHits`. |
| `unverifiable` | `file-missing` | The fault's `file` does not exist. |
| `unverifiable` | `defenders-failed-to-load` | The defenders did not load on unmodified code. |
| `unverifiable` | `defender-discovery-indeterminate` | Automatic discovery could not resolve a candidate test file safely. Uncertainty never becomes `nocover`. |
| `unverifiable` | `subject-not-executed` | The negative control: with the target replaced by something that cannot compile, the defenders stayed green, so they never execute it. A survivor there would describe their reach, not their assertions. |
| `unverifiable` | `probe-error` | Probing this fault threw. `detail.message` names what. |
| `fault-invalid` | `replacement-does-not-compile` | The runner reported a parse or transform error. |
| `fault-invalid` | `suite-failed-to-load` | The suite failed to load for another reason. |
| `timeout` | `test-timed-out` | A probe run timed out. |
| `flaky-defender` | `defenders-not-green` | Not N/N green on unmodified code. `detail.flakeRate` says how often. |
| `flaky-defender` | `inconsistent-probe` | Some probe runs killed the fault and some did not. |

### Provisional verdicts

A run with `--confirm` below 3 is **provisional**. Every verdict prints with a
trailing `?` (`SURVIVED?`, `killed?`), the summary starts with
`PROVISIONAL:`, a warning is printed on stderr, the evidence records
`run.provisional: true` and goes to `.testguard/evidence-provisional.json`,
and `baseline` refuses to freeze it without `--allow-provisional`. It exists
for the fix loop, a fast signal while writing a test, not for a gate.

### Record details

Fields on `detail` beyond `reason`. They describe how a verdict was reached;
none of them changes it.

| Field | On | Meaning |
|---|---|---|
| `baselineRuns`, `probeRuns` | every injected fault | Every run of the defenders, unmodified and with the fault applied. |
| `flakeRate` | every fault whose baseline runs ran | `{runs, failures}`: how many runs on unmodified code failed. Load errors and timeouts are excluded from both numbers. Any failure makes the verdict `flaky-defender`. |
| `independence` | `killed` | Whether the killing test was last touched by the same change as the code it guards: `co-authored` (same commit, or the same author), `separate-change`, or `unknown` (no history: an untracked file, a shallow clone). A signal for ranking; a co-authored kill is legitimate, but a suite where every kill is co-authored has no independent verification. |
| `negativeControl` | would-be survivors | `reached` (the defenders went red when the target could not compile, so they do execute it) or `not-reached` (the verdict becomes `unverifiable`, `subject-not-executed`). |
| `targetNotImported` | Python | With the fault applied, no defender imported the target module at all. A fact about the tests' reach, not their assertions. A module imported from outside the tree being probed is not recorded here: that run is refused. |
| `escalated`, `escalationRuns` | survivors | The whole suite was re-run with the fault applied. |
| `escalationStoppedEarly` | survivors | `no-common-failure`: escalation stopped because no test had failed in every run so far. It can only fail to name a killer, never upgrade a verdict. |
| `undeclaredKillers` | `killed-by-undeclared-tests` | The tests that failed in every escalation run. |
| `anchor` | anchor reasons | `{hits, expected}`. |
| `restoreSkipped` | rare | `target-missing`: something outside the process deleted the target during the run. |
| `message` | `probe-error` | The first line of what threw. |

## Defender signals

Static facts about the defenders, recorded in `defenders.signals` on the
evidence record and printed by `claims` and `probe`. **A signal never changes
a verdict.** It explains one, or points at the cheapest place to look.

| Signal | Printed | Meaning |
|---|---|---|
| `mocked-never-asserted` | `MOCKED-NEVER-ASSERTED` | A test file mocks the target module (`vi.mock`, `jest.mock`) and never asserts on anything imported from it. The exact signature of an escaped bug in field reports. Silence it, visibly, with `// unasserted: <why>` (or `# unasserted: <why>` in Python) on or above the mock. |
| `unasserted-annotated` | `unasserted (annotated)` | The same, with the author's annotation recorded as `reason`: silenced, never hidden. |
| `target-attribute-patched` | `attribute-patched` | A Python defender patches individual attributes of the target (`patch("pkg.mod.fn")`) rather than the module. The file stays a defender, because a fault elsewhere in the module is still detectable; `reason` names the patched attributes, where it is least likely to notice anything. |
| `persistence-payload-unasserted` | in the sweep report | A resolved defender mocks the persistence layer, so it can prove the call shape and never that a row landed. Attached only to a `survived` record whose fault sits on a write path. `reason` names the mocked layer and the file's assertion mix (exact, partial, argument-free); `counts` and `specifiers` carry the same as data. |

Related defender fields on the record: `mocking` lists candidate test files
that import the target but mock it (a discovered file that mocks is excluded
from `resolved`, because a mock cannot detect a fault in what it replaced);
`discovered: true` marks defenders found by import rather than declared; and
`selectionSource` says where the selection came from (`fault`, `claim` or
`discovery`).

## Replay verdicts

Written by `replay`, one per fix commit. Replay reports and never gates; its
exit code is `0` whatever these say.

| Verdict | Meaning | Enters calibration |
|---|---|---|
| `caught` | A remaining test failed by assertion on the reverted source, every run. The suite knew. | yes, as caught |
| `blind` | The suite stayed green on known-broken code. | yes, as a miss |
| `nocover` | No remaining test imports the reverted files. Worse than blind. | yes, as a miss |
| `flaky` | The runs disagreed (`runs-disagreed`). A flaky failure would read as detection, so mixed runs are never `caught`. | no |
| `unverifiable` | Nothing could be concluded. | no |

Counting `nocover` as a miss is deliberate: leaving it out would score a
project with no tests for a subsystem better than one with weak tests.

| `unverifiable` reason | Meaning |
|---|---|
| `revert-did-not-apply` | The source revert did not apply. |
| `suite-failed-to-load` | The remaining suite could not load. |
| `timed-out` | A run timed out. |
| `failed-without-an-assertion` | Every run failed, but not by assertion. |
| `the-fix-shipped-the-only-test-file` | Removing the fix's own test left nothing to run. |
| `no-prior-version` | The commit only adds source: there was no earlier behaviour to be blind to. |
| `defender-discovery-indeterminate` | Discovery of the tests to run was indeterminate. |
| `no-runs` | Nothing ran. |

## Sweep

`sweep` records the same seven probe verdicts, but on faults nobody stated, so
it gates on fewer of them.

| Verdict | Exit |
|---|---|
| `survived` | `1`: something was deliberately broken and no test failed. |
| `nocover` | `1`: no test imports the swept file. |
| `unverifiable`, `fault-invalid`, `timeout`, `flaky-defender` | reported, never gating: they are statements about a machine-made proposal, and a tool that fails because its own guess was bad gets switched off. |
| `killed` | not listed as a finding. |

So `sweep` exits `0` when nothing survived and every swept file is imported by
a test, `1` otherwise, `2` when it cannot evaluate and `3` without a
reference. Presentational elements (icons, static wrappers) are set aside
before selection and counted, never probed, and faults beyond `--cap` are
reported as deferred: neither is a verdict.

## Admit

`admit` reduces the claim's records to one answer.

| Answer | Exit | When |
|---|---|---|
| `ADMITTED` | `0` | Every fault of the claim is `killed`, N/N, by defenders that are green N/N on unmodified HEAD. |
| `ADMITTED?` | `0` | The same at `--confirm` below 3. Provisional: confirm with `--confirm 3` before committing. |
| `NOT ADMITTED` | `1` | Anything else. It names the first blocking fault, in this order: `survived`, `nocover`, `unverifiable`, `fault-invalid`, `timeout`, `flaky-defender`, and what to do about it. |

A test that is neither a declared nor a discovered defender of the claim is
refused before anything runs (exit `3`), because a kill would then be another
test's work.

## Other findings

Labels that are not verdicts but still affect an exit code or the next action.

| Label | From | Meaning | Exit effect |
|---|---|---|---|
| `UNDECLARED` | `claims` | A `@claim <ID>` annotation in source has no entry in the claims file. | `claims` exits `1` |
| `STALE` | `claims` | An annotation-sourced claim has no `@claim` annotation left in source. | `claims` exits `1` |
| `NARROWED-DEFENDERS` | `claims` | A fault now selects fewer defenders than it inherited, after a prior kill. The old kill does not prove the narrower set: re-probe. | none |
| `INVALID` | `status` | An exact anchor is missing or ambiguous. State `invalid-anchors`, next action `repair-fault`. | `status` exits `1` |
| `ANCHOR-MISSING`, `ANCHOR-AMBIGUOUS`, `FAULT-INVALID` | `claims --check-anchors` | The same anchor check run on demand; `FAULT-INVALID` here means a JavaScript or Python replacement no longer parses. Nothing is run. | `claims` exits `1` |
| `CHANGED` | `status` | A fault's content changed since it was probed. If its last verdict was not `killed`, the state is `evidence-stale` and the next action is `review-fault-change`: weakening a fault is the cheapest way to make a survivor disappear. | `status` exits `1` |
| `UNCLAIMED` | `gate` | A changed source file carries no claim and no excusing ignore entry. | `gate` exits `1` |
| `EXPIRED` | `gate`, `claims --since` | An ignore entry past its `expires`; it excuses nothing. | none by itself |
| `delegated` | `gate` | Changed files that belong to a nested project; run `gate` there. | none here |
| `REMOVED` (`removed-claim`, `removed-fault`) | `claims --since` | A claim or fault that existed at the reference and does not now, with its last verdict where evidence exists. | `claims` exits `1` unless an ignore entry excuses it |
| `renamed` (`renamed-claim`) | `claims --since` | A removed ID whose statement reappears verbatim under a new ID. | none |

## Next

- [Gate semantics](../../spec/GATE-SEMANTICS.md): the normative rules.
- [CLI reference](cli.md): each command's exit codes.
- [Writing claims](../guides/writing-claims.md): turning a `SURVIVED` into a test that kills it.
- [Replay guide](../guides/replay.md): reading a calibration.
