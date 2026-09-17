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
   probe runs, all agreeing. Default N is 3. **Fewer than three runs is
   provisional**: the evidence declares `run.provisional: true`, every
   rendering marks the verdicts as unconfirmed, and a provisional run is
   never frozen into a baseline. Provisional runs exist for the fix loop —
   a fast signal while writing a test — not for a gate.
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
8. **A changed fault is a finding.** Editing a claim is legitimate — claims
   can be wrong — but the cheapest way to make a survivor disappear without
   writing a test is to weaken its fault. Evidence records each fault's
   content hash; the status document lists every fault whose content
   changed since it was probed, with its previous verdict. The change is
   allowed; it is never invisible.

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
- A **signal** is a static, annotation-grade fact about a defender, recorded
  on the evidence and never a verdict. `mocked-never-asserted`: a test file
  mocks the subject's module and never asserts on anything imported from it.
  An author may silence it with `unasserted: <reason>` above the mock; the
  tool then records `unasserted-annotated` with the reason — silenced, never
  hidden. A file that mocks the subject is never a discovered defender: a
  mock cannot detect a fault in what it replaced.

## Claim coverage of a change

`probe` asks whether the tests defend the claims that exist. It says nothing
about code that has no claim, by construction — and every escaped defect the
field reports share was a *claim gap*, not a defender gap: the feature shipped
green with zero claims. A repository with ten old claims and one new,
unclaimed module exits 0 under `probe` forever.

The change gate closes that hole. Given a reference, a tool measures the
**delta** — the files changed since `merge-base(ref, HEAD)`, or since that
merge-base in the working tree — file by file:

- A changed file is **excluded** when it is not source (by extension) or
  matches a documented never-claimed pattern (`*.d.ts`, `*.config.*`,
  fixtures, mocks, snapshots, the tool's own directory). Exclusions are
  listed, never silent.
- A changed source file is **covered** when at least one fault anchors to it,
  when it is a test file that resolves as a defender of some claim, or when an
  **unexpired** `path` ignore entry excuses it.
- Anything else is **uncovered**. The unit is the file, on purpose: a fault
  anchors to a file, so the file is the smallest unit the rest of the
  contract already understands.

Rules:

1. **One uncovered file gates.** Exit `1`. There is no threshold and no
   percentage; a percentage is how the gap hid before.
2. **Every reliance on an ignore entry is reported.** The gate may pass
   *because of* an excuse; a reviewer reads which entries carried it, with
   their reasons and expiry. An expired entry excuses nothing and is reported
   as expired.
3. **A test file needs a claim too.** A test that defends no claim is the
   authorship trap the pattern exists for; it is uncovered until a claim
   names it in `defendedBy` (or discovery resolves it as a defender).
4. **Never a silent pass on nothing.** A non-empty change whose files were
   all excluded passes with an explicit "0 evaluated" line; a tool offers a
   strict mode that fails it instead. An empty change is an honest `0`.
5. **The reference is never guessed.** An explicit flag, or a CI-provided base
   branch, or an error. An upstream that already contains the change has an
   empty diff and would pass trivially.
6. **Unclaimed changes precede every evidence state.** When the status
   document knows a reference and finds uncovered files, its state is
   `unclaimed-changes` and its next action is to write the claim, before any
   `unproven` finding is surfaced. The brief renders them first. The claim is
   written before more code.

Exit codes: `0` every changed source file is claimed or excused (or nothing
changed); `1` at least one uncovered file (or strict mode over an
all-excluded change); `2` the change cannot be evaluated (unresolvable
reference, invalid claims or ignore file, no repository); `3` no reference.

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
