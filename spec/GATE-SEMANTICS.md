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
| `unverifiable` | The claim could not be probed: the fault's anchor is missing or ambiguous, its defenders failed to load (`defenders-failed-to-load`), probing it threw (`probe-error`), or the defenders do not execute the subject at all (`subject-not-executed`). Carries a `reason`. A loud, gating verdict — a claim that cannot be probed is not "skipped", it is undefended until someone fixes the fault or the defenders. Never confused with `flaky-defender`, which requires tests that *ran*. | **yes** |
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
   these apart. A runner's own retry mechanism does not change this: a test
   that failed and then passed on retry (Playwright's `flaky`) is a
   **non-green run** even when the runner exits 0, and a test the runner
   reports as timed out (`timedOut`) is a timeout, never an assertion
   failure. Python is read the same way: an `AssertionError` and any other
   exception raised by the test body both count, because both are the suite
   rejecting the behaviour; a collection error — a module that will not
   import, which is what a replacement that does not parse looks like from
   Python — is a load failure and never a kill; and a test the suite expected
   to fail that passed (`xpass`) makes the run non-green without ever being an
   assertion failure, exactly as Playwright's `flaky` does. When one claim's
   defenders run under several runners, their runs merge pessimistically —
   any load error is an error, any timeout is a timeout, any failure is a
   failure — and the evidence names which file ran under which runner.
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
   Attribution runs **up to N times**, and stops as soon as no test has failed
   in every run so far: from there no further run can name a killer. The
   evidence records the early stop (`detail.escalationStoppedEarly`). Stopping
   can only fail to *name* a killer, never upgrade a verdict, which is the
   pessimistic side.
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
   The same hash governs **reuse**: a tool that carries a prior verdict
   forward to save a run may only do so for the fault that produced it. A
   verdict is an answer about one exact `find`/`replace`, so once those
   change the old answer is not an answer to the new question — a weakened
   fault would keep the verdict it earned before, and a repaired anchor would
   keep `unverifiable`. Where the prior record has no content hash to compare,
   the fault is probed again: the cost of re-measuring is a run, the cost of
   the other direction is a verdict nobody measured.

9. **The fault must be the code that ran.** A green baseline proves the
   harness is not reporting everything as broken. It proves nothing about the
   opposite direction: a fault the interpreter never executes leaves the
   baseline green, every verdict `survived`, and a report that reads as a
   devastating finding while being entirely false. A tool that can tell which
   file was actually loaded must check it while the fault is applied, and must
   **refuse the run** when the subject was loaded from outside the tree being
   probed — in Python an editable install (PEP 660) registers an import hook
   consulted ahead of every path entry, and a plain install leaves a copy in
   `site-packages`, so this is the normal case, not an exotic one. When no
   defender imported the subject at all, the run continues: an import inside a
   branch the fault does not reach is legitimate. It is recorded as
   `detail.targetNotImported`, because a `survived` there is a statement about
   the defenders' reach and not about their assertions, and the two must not
   be read as the same finding.
10. **A signal describes a file, and says which kind of blindness it is.**
   Replacing a whole module (`vi.mock`, `jest.mock`, a Python `patch` of the
   module itself) removes a file from the defenders: it cannot detect anything
   in what it replaced. Replacing **one attribute** of a module —
   `patch("pkg.mod.fn")`, which is what Python code almost always does — does
   not: a fault anywhere else in that module is still fully detectable, and
   dropping the file would report `nocover` for a claim that is well defended.
   The file stays a defender and carries `target-attribute-patched`, naming
   the attributes. Signals never change a verdict.

11. **One fault's failure costs that fault, not the run.** A fault whose probe
   throws is recorded as `unverifiable` with reason `probe-error` and a
   `detail.message` naming what threw; the run continues and still writes its
   evidence. Losing the document would throw away every verdict already
   decided and leave a caller with an exit code this document does not define,
   which is strictly worse than one loud unverifiable claim. A `probe-error`
   record is never reused by a later run: it says something about the run, not
   about the code. The one exception is a **precondition** failure — the
   interpreter loading the source from outside the probed tree, a runner that
   does not resolve — which is a statement about every verdict in the run and
   still refuses it outright.
   Restoring the source is held to the same reading. The restore is
   belt-and-braces in worktree mode, where the mutation only ever existed
   inside a scratch worktree that is discarded anyway, so a target that has
   vanished is already restored and is recorded as
   `detail.restoreSkipped: "target-missing"` rather than raised — a reader can
   still see that the tree moved underneath the run. Under `--in-place` the
   same condition is the user's own file gone and must be raised. Any other
   failure to write the original back is raised in both modes: it can mean a
   mutated file left on disk.

12. **A survivor must prove the defenders execute the subject.** A green
   baseline proves the defenders can *pass*. It does not prove they can fail
   *because of this file* — and if the fault is applied to code the test
   process never executes, the baseline is green, every probe run is green,
   and every claim is reported `survived`. That output reads as a devastating
   audit finding and is entirely false, and no individual check in the run
   contradicts it.
   So a would-be `survived` is charged one more run: the subject is replaced
   with content its loader cannot parse, and the defenders run once. Going red
   proves they execute it (`detail.negativeControl: "reached"`), and the
   `survived` stands. Staying green proves they do not, and the verdict is
   `unverifiable` with reason `subject-not-executed` — the pessimistic reading,
   and the only honest one, because nothing was measured about their
   assertions.
   Charged **only** on a would-be survivor, and cached per subject and defender
   set. A kill already proves the defenders reached the code, so paying there
   would be waste. A runner that cannot say what "cannot compile" means for its
   language does not guess: no control is run, no signal is recorded, and the
   verdict is unchanged. `detail.targetNotImported` (reported by runners that
   can name the file the interpreter loaded) answers the same question more
   precisely for one language; where both are present they must agree.

13. **Fault injection is one method, not the definition.** A claim declares
   what must be true; a probe declares how a tool would try to make it false,
   and `method` says which way. `fault-injection` — mutate the source, run the
   claim's defenders, confirm over N runs — is the only method specified in
   v1, and it is the default when the field is absent, so every document
   written before the field existed is held to exactly the rules it was
   written against.
   Everything in this document above this rule is `fault-injection`'s
   semantics. `confirmRuns`, `mode`, `defenders`, `inputs` and the baseline
   and probe runs are what *it* means by showing its work; a tool that reads
   code or scans a surface has none of them, and requiring them would force it
   to emit empty arrays to conform — which is lying, and the one thing this
   format exists to make impossible. The schema therefore requires them only
   under `fault-injection`, and the validator enforces them there in full: the
   relaxation is for a tool that injects nothing, never a licence for an
   injecting tool to stop showing its work.
   A reserved method carries its own data in `methodDetail`, on the probe and
   on the record: an object the spec deliberately does not constrain, so a tool
   can say which rule it checked and where. Without it, "reserved" would mean a
   probe that can declare it exists and nothing about it, which is not a
   reservation but a dead end. It is **forbidden under `fault-injection`**,
   whose shape is specified and must not acquire a junk drawer, and it is a
   staging area rather than a permanent home: what the first consumer puts
   there is the evidence for what the specified shape should become.
   `assertion` and `scan` are **reserved**. Their required fields are
   deliberately unspecified and will be defined by their first real consumer,
   with its own conformance examples written from the shape that tool actually
   has. Designing them for an absent tool is precisely the mistake that made
   this rule necessary: the spec was drafted against a single consumer and
   hard-coded its assumptions as requirements.
   The verdict set stays closed and shared. What each method may legitimately
   report is part of defining it.

## Replay reports; it never gates

A replayed bug is history. It escaped, by definition, which means the suite
missed it; a gate on that is a gate nobody can pass on a first run, and it
would only teach teams to stop looking. `replay` therefore always exits `0`
unless it could not run at all.

Its verdicts mirror the probe's, for the same reasons:

| Verdict | Meaning |
|---|---|
| `caught` | a remaining test failed **by assertion** on the reverted source, every run. The suite knew. |
| `blind` | the suite stayed green on known-broken code. |
| `nocover` | no test imports the reverted files. Worse than `blind`: nothing was even tried. |
| `unverifiable` | the revert did not apply, the suite failed to load, or it timed out. Carries a `reason`. |
| `flaky` | the runs disagreed. A flaky failure reads as "the suite caught it", so flakiness biases this metric **optimistically** — mixed runs are never `caught`. |

Two rules that follow:

1. **One patch, one row.** De-duplicate by `git patch-id`; a dual-branch
   topology carries the same fix under two or three shas, and counting it
   twice corrupts the corpus a calibration is computed from.
2. **The fix's own test is removed before the run.** It proves nothing about
   what the suite knew before the fix existed.

`caught`, `blind` and `nocover` are measurements and enter the calibration
ratio: `caught` as a hit, the other two as misses. `nocover` counts as a miss
because it is one — the worst kind. Leaving it out would let a project with
**no tests at all** for a subsystem score better than one with weak tests,
since its worst outcomes would leave the denominator before the ratio is
taken; Stryker and PIT count no-coverage mutants against the headline score
for the same reason. `flaky` and `unverifiable` are failed measurements and
enter neither side.

### Calibration arithmetic is reproducible

A calibration cell declares `n` and `positives`, and with them has declared
`p`; a document declares `method: wilson` at `confidence`, and with them has
declared every `ci`. The validator recomputes both with `lib/wilson.mjs` —
the single implementation, as `lib/fingerprint.mjs` is for fingerprints — and
a cell that does not reproduce does not conform. Before this rule the
validator checked only that `p` lay inside `ci`, which a document with every
number invented satisfies, and the spec's own example shipped a truncated
lower bound (6/30 → `0.09`, where Wilson gives 0.0950 → `0.10`) that nothing
could notice.

- **Precision is the document's own**: the most decimal places any `p` or
  `ci` value shows, capped at 6. Values are compared after rounding to that
  precision, so a producer at 3 dp and one at 4 dp both reproduce and a
  truncated bound does not.
- **z may be the exact quantile or the textbook rounding** (1.96, 2.576,
  1.645). The two differ by up to 9.2e-6 in the interval — enough to flip a
  rounding boundary at 4 dp — so either reproduces, and a document never fails
  for having used the number in the textbook.
- **`p` is `positives / n`.** A smoothed or shrunk point estimate is a
  different method and must say so; under `wilson` the point estimate is the
  observed proportion.

### Calibration provenance, backoff and merging

Everything beyond a document's primary buckets is optional and additive, in
the way `method` is on claims and evidence: absence has a defined meaning, and
no document written before a field existed becomes invalid. The meaning of
absence is **unattributed** — readable, auditable, and not a source of
numbers. A tool that emits calibrations always emits these fields; a
self-claim guards that it does.

- **`measures`** says what `p` is the probability of. It is the one field
  that lets two calibrations be told apart: testguard's `escape-missed` is
  P(a real escaped bug of this class was not caught), and high is bad;
  websec-validator's `finding-real` is P(a reported finding of this class is a
  real vulnerability), and high is good. A document without it cannot be
  quoted and cannot be merged. Registry: `escape-missed`, `finding-real`. A
  new value is added here by the tool that first emits it.
- **`source`** carries provenance. `corpus` names external ground-truth
  sources (a bug-replay's is the repository's own history, which `ref` already
  names); `caveat` is the one sentence a consumer shows beside any quoted
  number; `limitation` is the longer story; `evidenceStatus` says whether the
  labels were reviewed; `kind: tool-oracle` is a tool confirming its own
  findings, as websec-validator's dynamic probes do. `detail` is the tool's
  own provenance, unconstrained, on the `methodDetail` pattern. A number
  quoted without its `caveat` is a misquote.
- **`minN`** is the producer's floor. A cell below it is not quoted on its
  own; the consumer backs off a tier. A consumer may raise it — a gate that
  blocks a merge wants more certainty than a report — and may never lower
  it: lowering it resurrects a cell the producer suppressed. Absent, the
  producer sets no floor and the consumer applies its own. A spec-level
  constant would be wrong in both directions: websec-validator's 5 would
  suppress every cell of a corpus the size of DocGuard's benchmark.
- **`backoff`** is the ordered list of coarser tiers consulted below `minN`.
  Each tier is held to the same arithmetic as the primary. Keys may be
  compound (`attackClass|confidence` backs off to `confidence`), and every key
  in a tier has as many `|`-parts as its `bucketBy` — a key with fewer was
  translated from another table and lost a dimension on the way.
- **`fallback`** is what remains when no tier has a cell above `minN`: a
  labelled guess, not a measurement, and anything quoted from it carries
  `n = 0`, `ci = [0, 1]` and its `basis`. It lives in the document so that
  "what did it assume when it had no data?" has one auditable answer instead
  of one per consumer, each unlabelled.
- **`breakdown`** splits a cell's `n` by outcome when the producer can say
  (testguard: `caught` / `blind` / `nocover`), and sums to `n`. It lets a
  consumer recover a narrower rate — misses among covered code, say —
  without the producer publishing a second, misleading headline.

**Merging.** Two calibrations merge by summing `n` and `positives` per cell
and recomputing `p` and `ci` from the sums — never by averaging `p` or `ci`,
which have no meaning combined. They merge only when `measures`, `bucketBy`
and `confidence` agree, and the merged document's `source.kind` is `mixed`.
This is how websec-validator folds an operator's own confirmed samples over
its shipped table, and it works only because cells carry raw counts.

**The second producer is a conformance example.** websec-validator's shipped
table, translated field for field, is `conformance/examples/calibration-websec.json`
— corpus, caveat, limitation, floor, backoff tier and labelled fallback all
present. That file, not a sentence in a README, is what "adoptable" means.

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

A baseline records the commit its evidence was taken at. When that evidence
came from a working-tree snapshot, the baseline says so (`snapshot`) and its
`head` is the **parent** of the commit that will carry the tests. A tool may
offer to re-stamp such a baseline onto a later commit, but only when a clean
probe of that commit reproduced exactly the same fingerprints; otherwise the
user re-probes and freezes a new baseline. A frozen contract is never
silently rewritten, and a status document notes a baseline that predates
HEAD without turning that into a state.

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
  `persistence-payload-unasserted`: a resolved defender mocks the persistence
  layer, so it can prove the call shape and never that a row landed; the
  reason names the layer and the file's assertion mix. It is attached only to
  a **survived** record whose fault sits on the write path — a field of a
  persisted payload or the write call itself — because there it says why the
  survivor was missed, and anywhere else it says nothing. A conforming
  document never carries it on another verdict, on a file that is not a
  resolved defender, or without its reason.

## Claimed source surface

`status` reports the denominator that `probe` cannot: current, non-test source
modules with a supported extension and outside the change gate's documented
default exclusions. A module is claimed when at least one fault anchors to it.
The document carries the claimed, unclaimed and total module counts.

The report also names concrete unclaimed modules. It counts touches over at
most the latest 200 commits, reports how many of the 20 highest-churn modules
are claimed, and lists up to ten unclaimed modules in descending churn order.
Security- and money-shaped path names are explicit tie-breaking signals, never
semantic claims about a file. Churn, path risk and claim coverage remain raw
facts: they are never collapsed into one health score.

When existing evidence is clean but more source modules are unclaimed than
claimed, the next action is to scaffold the highest-churn unclaimed module.
Earlier correctness states still win: invalid anchors, stale evidence and
unproven faults are repaired before expanding the denominator. Without git
history the counts and concrete files remain available, while the document
says history is unavailable and reports zero commits read.

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
5. **The reference is inferred only from recorded intent.** Resolution stops
   at the first available source: an explicit flag, `TESTGUARD_CHANGED_REF`, a
   CI-provided base, the configured remote's symbolic default branch, then a
   configured upstream whose branch name differs from the current branch.
   Local discovery never compares a branch to its same-name remote-tracking
   ref: that ref may already contain the whole change and yield a false empty
   diff. It also declines to compare the default branch to itself. When Git
   records no safe local base, the gate exits `3` and asks for `--changed`.
6. **Unclaimed changes precede every evidence state.** When the status
   document knows a reference and finds uncovered files, its state is
   `unclaimed-changes` and its next action is to write the claim, before any
   `unproven` finding is surfaced. The brief renders them first. The claim is
   written before more code.

Exit codes: `0` every changed source file is claimed or excused (or nothing
changed); `1` at least one uncovered file (or strict mode over an
all-excluded change); `2` the change cannot be evaluated (unresolvable
reference, invalid claims or ignore file, no repository); `3` no reference.

## Anchor preflight

`claims --check-anchors` answers what is knowable before a runner starts. For
every fault-injection fault it reads the target, applies the same exact
`locate()` arithmetic as a probe, and reports `ok`, `anchor-missing` or
`anchor-ambiguous` with the observed and expected hit counts. When a language
has a cheap parser, it also parses the in-memory replacement (`node --check`
semantics for JavaScript modules, `compile()` for Python). Unsupported
languages are anchor-checked and otherwise skipped without inference.

One non-`ok` anchor or non-parsing supported replacement exits `1`. The check
runs no tests, creates no worktree, reads no git state and writes no source.
It is not evidence that a defender detects the fault; the self-probe still
runs after it. There is no automatic repair or fuzzy relocation: choosing a
new anchor is a semantic edit to the claim and must be reviewed and re-probed.

`invalid-anchors` precedes every evidence state in the status document (after
`unclaimed-changes`, when a change reference is known). Its next action is
`repair-fault`, naming the first fault and `testguard claims --check-anchors`.

## Partial probe scope

Every `--claim` occurrence contributes to the selection. Comma-separated ids
inside each occurrence are flattened in first-seen order and duplicates are
collapsed. An explicitly empty selection is a usage error, never a successful
zero-record probe. Partial human output and the `probe --json` run wrapper name
the requested and actually probed claim ids and counts. Commands whose
`--claim` is singular (`scaffold` and `admit`) reject repeated or comma-separated
values instead of silently choosing one.

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
