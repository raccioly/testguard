# Gate semantics

How a Guard-spec tool decides whether CI goes red. Shared by every tool that
adopts the spec; each tool may add stricter rules, never looser ones.

## Verdicts

The verdict set is closed. Only one value is a pass.

| Verdict | Meaning | Gates by default |
|---|---|---|
| `killed` | Fault applied; every one of N probe runs failed with a genuine assertion failure, on a defender set that was green N/N unmodified. | no |
| `survived` | Fault applied; every one of N probe runs passed. The claim is **unproven**. | **yes** |
| `nocover` | No defending test exists: the declared globs resolve to nothing, or no test imports the subject. Worse than `survived` — nothing was even tried. | **yes** |
| `unverifiable` | The claim could not be probed: the fault's anchor is missing or ambiguous, or its defenders failed to load (`defenders-failed-to-load`). Carries a `reason`. A loud, gating verdict — a claim that cannot be probed is not "skipped", it is undefended until someone fixes the fault or the defenders. Never confused with `flaky-defender`, which requires tests that *ran*. | **yes** |
| `timeout` | Probe run exceeded its budget. Not counted as a kill; the pessimistic reading is the safe one because flakiness biases the metric optimistically. | **yes** |
| `fault-invalid` | The replacement does not load or compile. A bad fault, not a detection. | **yes** |
| `flaky-defender` | Defenders were not green N/N on unmodified source (`defenders-not-green`), or the N probe runs disagreed with each other (`inconsistent-probe`). Either way no verdict about the fault can be trusted; fix the defenders first. | **yes** |

Rules that follow from the table:

1. **Green baseline first.** Defenders run N times unmodified before any fault
   is applied. Anything short of N/N pass is `flaky-defender` and stops there.
2. **Confirm over N runs.** `killed` and `survived` both require exactly N
   probe runs, all agreeing. Default N is 3.
3. **Only a test body rejecting the behaviour kills.** A test that fails by
   assertion — or by an exception the fault provoked inside it — counts. A
   timeout does not, and a suite that fails to load does not: neither is
   evidence that the suite defends the claim. Tools parse the runner's
   structured report, never its exit code, because the exit code cannot tell
   these apart.
4. **A mixed result is not a kill.** If some of the N probe runs fail and
   others pass, the defender's response to the fault is nondeterministic.
   Reporting `killed` would be the optimistic bias flakiness introduces;
   reporting `survived` would be wrong the other way. It is `flaky-defender`.
5. **Escalation never upgrades a verdict.** A fault that survives its declared
   defenders may be re-run against the whole suite. If the wider suite kills
   it, the verdict stays `survived` with reason `killed-by-undeclared-tests`
   and `detail.undeclaredKillers` names the tests, so the author can fix
   `defendedBy`. The claim's stated evidence chain is broken even though the
   suite is not blind. It gates, and ranks below a true survivor.
6. **A verdict names the commit it is about.** Evidence records `repo.head`;
   when the working tree was probed instead, `repo.snapshot` holds the
   throwaway commit that captured it. A tool must refuse to probe a commit
   while defenders or targets have uncommitted changes, unless told to
   snapshot the working tree — otherwise the answer looks right and is not.
7. **Never a single global score.** Output is per claim, ranked. Blindness is
   concentrated, and one number hides where.

## Baseline and delta

A baseline freezes the fingerprints of every non-passing finding at a point
in time. On later runs:

- A finding whose fingerprint appears in the baseline is **baselined** and
  suppressed, up to the stored `count`.
- Any other non-passing finding is **new** and gates.
- `killed` findings are never fingerprinted; a baseline holds only debt.

The fingerprint is `sha256(claimId \n subjectId \n file \n verdict)`. It is
derived from identities and outcome, never from the fault's `find`/`replace`
text, so repairing a rotted anchor does not churn the baseline — while a
change of verdict on the same claim+subject does surface as new.

Adopting tools may reconcile an existing baseline format (for example a
`{version, fingerprints:{hash:count}}` file) by mapping it onto this shape;
the suppress-up-to-count semantics are identical.

## Ignore and annotations

- An ignore entry removes a subject from *scope* before probing. Every entry
  carries a `reason` of at least eight characters; the structured form is what
  an auditor reads. A plain gitignore-syntax file may be accepted as shorthand
  for reasonless `path` entries.
- An annotation is **strictly additive**. It never changes, suppresses, or
  drops a finding. Ranking may read annotations; verdicts never do.

## Severity floor

`--severity <level>` gates only findings whose claim severity is at or above
the level. Findings below the floor are still reported and still written to
evidence; they simply do not turn CI red.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No new gating findings at or above the severity floor. |
| `1` | At least one new gating finding. |
| `2` | Precondition failed: test runner not resolvable (e.g. no `node_modules` linked into the scratch worktree), working tree dirty for a fault target file, claims file invalid, no commits. Nothing was probed. |
| `3` | Usage or configuration error. |

A tool must never exit `0` because it had nothing to check. If the claims
file is empty or every claim is out of scope, that is reported explicitly and
the exit code is `2`.
