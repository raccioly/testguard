# Gate semantics

## Declared claim origins

Status rechecks every recorded automatic-discovery dependency hash, including
negative candidate tests, barrels and resolver configuration. Edited, deleted,
unreadable or non-regular/escaping inputs make the evidence stale without
rewriting its verdicts. Legacy omission remains readable but does not establish
a complete origin-policy freshness binding. Rechecking recorded dependencies
alone does not detect a newly added test/configuration: native test-universe
recomputation remains required before origin-policy activation.

Canonical and recorded claim sources share the closed kinds `spec`, `adr`,
`annotation`, `comment`, `manual`, `doc`, `bug`, `incident`, `review`, `inferred`.
These are declarations, not authentication of independence, chronology,
production occurrence or correctness. The optional reference remains opaque
metadata (at most 512 characters); verification does not fetch it. Producer
provenance and measured test independence are separate signals.
Adding kinds does not change verdicts, baseline/fingerprint identity or default
gates. Existing ranking weights stay unchanged; new kinds use the existing 0.9
fallback, not an invented strength hierarchy. Existing documents remain valid
under the candidate reader; older closed-schema readers reject new kinds.
Optional `origins` summaries on evidence, status and brief have closed kind
buckets and safe nonnegative integer counts. Distinct claim buckets plus
`mixed` equal the claim total; record buckets equal the record total. Status
uses `basis: declared`, omits records, has zero mixed claims and binds its
total to current `counts.claims`, even when evidence is stale. Evidence and
brief use `basis: recorded` and require record counts. Evidence validation
recomputes from every actual record regardless of verdict: each claim ID
counts once, with conflicting source kind OR reference counted as one mixed
claim. Object-key order is not a conflict; absent and empty references differ.
Brief totals bind to the complete summary, not its capped/filtered items.
Status and brief omit the source projections needed to independently validate
their kind split; arithmetic validity is not source authentication. Legacy
documents without summaries remain valid; old closed readers reject them.
Status supplies current declared origins once validated claims are available,
including empty, unprobed, invalid-anchor and stale-evidence states. Probe
evidence and evidence-backed briefs supply recorded origins from all records,
including killed and non-killed records, before caps or baseline/floor filtering.
Human status/probe/brief text and Markdown label the basis and print "declared
origins, not authenticated independence". Evidence-free briefs and projects
without a claims file omit the summary rather than inventing declarations.
Probe JSON retains status's current declared basis; saved evidence has its own
recorded basis. These informational fields do not change states, next actions,
exit codes, fingerprints or default gates. Opt-in origin policy remains pending.

## Explicit annotation authoring

Ordinary `claims` reports a separate `annotationAdvisory` with distinct sorted
`missingIds` and informational `notes`; status uses its existing informational
`notes`. Missing links reduce discoverability and annotation reconciliation,
not exact-anchor validation. Advice supplies `testguard claims --annotate` for
read-only preview; it never changes state, next verification action, verdicts,
source kinds or exit codes. Annotation-sourced missing IDs still retain the
existing claims drift error. Scanned occurrences are lexical links, not proof
of intent, source ownership or authenticated provenance.
Status advisory scanning is bounded to 10,000 directory entries, 1,000 files,
64 directory levels, 256 KiB per file and 2 MiB total read bytes. Read failures,
unsafe file identities or limits produce unavailable advice, never a claim
that an ID is absent from an incomplete scan. Verification state/next still
comes from its existing inputs. For custom claims, preserve the original
`--claims` argument when following the preview suggestion.
Scanner and placement ID prefixes use mandatory separators between repeated
alphanumeric groups, avoiding overlapping quantifiers on tokens lacking a
hyphen without changing the supported identifier vocabulary.

`claims --annotate` previews file-header placement without writes. Add `--apply`
to explicitly apply a newly computed plan; a previous invocation's preview is
not a saved approval token. Repeated/comma-separated `--claim` selects IDs;
unknown or empty IDs are usage errors, never an implicit all-claims selection.
Authoring flags are valid only on `claims`; `--apply` requires `--annotate`.
Authoring rejects unrelated inspection/output switches and writes results only
to stdout. It never updates claims metadata, evidence or baselines.

The closed `annotations` document describes authoring, not verification. It
contains selected IDs, admitted target/action summaries, refusals and, for
apply, touched/verified/unchanged files and explicit failure/recovery details.
It excludes source/proposed contents, inode identities, hashes and absolute
source/root paths. Preview exits 0 when applicable, 2 when refused. Apply exits
0 only for a fully verified apply (including idempotent no-op), 2 for refusal or
partial failure. Invalid invocation exits 3. No authoring result changes probe
verdicts, rank, coverage, source-kind declarations or authentication of intent.
Failure reasons are stage-specific public summaries: raw syscall details can
contain absolute input paths and remain private, never passed through to JSON.

Placement supports JavaScript/TypeScript and Python file-level line-comment
headers, not symbol ownership. Exact anchors remain checked without annotations.
Every selected target must pass conservative path, regular-file, UTF-8/newline,
anchor and size admission: 2 MiB per original/proposed file and 16 MiB aggregate
charged before reads plus proposal growth. Any refusal blocks all writes.
Preserve BOM, shebang, Python encoding cookies, newline style, inode and mode.
Only leading line-comment headers are placement witnesses, not string contents.

Apply reloads actual claims under an exclusive owned lock, replays all targets,
and fsyncs owner-only originals/manifest outside the canonical project before
writing. Recheck claims and targets immediately before each non-truncating
descriptor write; verify output, distinguish potentially touched from verified
files, and retain private recovery on partial failure. Reject the actual claims
file as a target, root/descendant symlinks and recovery inside the checkout.
Resolve parent aliases to bind the actual root. Never reclaim another writer's
lock or automatically roll back over an editor's changes. Stage and fsync the
final recovery journal before final naming. This is recoverable, not atomic:
arbitrary same-inode editors and process/power failure can race or interrupt
writes; directory durability across power loss is not guaranteed.

## Fault-specific defender selection

A fault's `defendedBy`, when present, overrides its claim's declaration.
An explicit empty fault list requests discovery and never falls back to the
claim. Without a fault override, a non-empty claim list is inherited; otherwise
defenders are discovered. New evidence records `defenders.selectionSource` as
`fault`, `claim`, or `discovery`, alongside the actual requested and resolved
sets. Empty requests use discovery and carry `discovered: true`, including an
explicit empty fault override. Non-empty requests are never marked discovered.
Dirty-input preflight, runner ownership, mock-awareness, input hashing and
baseline caching all operate on each fault's selected defender set.

Changing requested globs, resolved files or selection origin invalidates verdict
reuse. Legacy evidence remains readable but cannot authorize a new fault-level
override. A strict resolved subset after a previous kill is reported by `claims`
as a narrowing warning and requires re-probing; it is not a new verdict.
Cost reports include per-fault recorded run durations and selection origin.
Shared defenders identify the actual fault records that selected each file,
including multiple faults within one claim. File costs remain overlapping upper
bounds, not additive shares. Existing total/per-claim budget ceilings are unchanged.

How a Guard-spec tool decides whether CI goes red. Shared by every tool that
adopts the spec; each tool may add stricter rules, never looser ones.

## Verdicts

The verdict set is closed. Only one value is a pass.

| Verdict | Meaning | Gates by default |
|---|---|---|
| `killed` | Fault applied; every one of N probe runs failed with a genuine assertion failure, on a defender set that was green N/N unmodified. | no |
| `survived` | Fault applied; every one of N probe runs passed. The claim is **unproven**. | **yes** |
| `nocover` | No defending test exists: the declared globs resolve to nothing, or no test imports the subject. Worse than `survived` — nothing was even tried. | **yes** |
| `unverifiable` | The claim could not be probed: the fault's anchor is missing or ambiguous, configured or symbol-level defender discovery was indeterminate (`defender-discovery-indeterminate`), its defenders failed to load (`defenders-failed-to-load`), probing it threw (`probe-error`), or the defenders do not execute the subject at all (`subject-not-executed`). Carries a `reason`. A loud, gating verdict — a claim that cannot be probed is not "skipped", it is undefended until someone fixes the fault or the defenders. Never confused with `flaky-defender`, which requires tests that *ran*. | **yes** |
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
   failure. Jest-compatible timeout messages are recognized by native runner
   error headers or structured timeout identity, not by words quoted in an
   assertion, stack frame, or source excerpt. Structured assertion identity
   does not hide a separate timeout in the same failed test.
   Python is read the same way: an `AssertionError` and any other
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

   **Claim metadata is also an input to reuse.** The recorded claim id,
   statement, severity, source (including its reference), and optional
   producer must match the current claim. Object-key order is not a change;
   field values and producer presence are. Metadata edits make `status`
   stale and require a fresh probe, even when the fault and defender inputs
   are identical. A reused record must never be silently relabelled as a
   different requirement or origin. Legacy records remain readable; missing
   metadata cannot establish equality with a current declaration. This
   does not change verdicts or baseline fingerprints, and a source label
   still does not authenticate independent intent.

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
   about the code. The same holds for a record whose reason is
   `defenders-failed-to-load`: a broken `--runner-cmd`, a missing dependency or
   an interpreter without the test requirements changes none of the hashed
   inputs, so fixing the environment would otherwise leave the failure
   reported as the current answer. Re-measuring it costs one baseline run per
   defender set. The one exception is a **precondition** failure — the
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

13. **The configured runner defines the test universe.** For JavaScript and
   TypeScript, defender discovery, baseline runs and escalation use the exact
   file set returned by the resolved runner's native listing protocol. A
   resolvable runner whose configuration cannot load, whose listing times out
   or is malformed, or whose reported paths escape the project is a
   precondition failure. It never falls back to built-in filename globs and
   never becomes `nocover`. An explicitly selected runner that lists zero
   files is also a precondition failure; `auto` may continue past a successful
   empty listing, but must fail when every eligible runner is empty.
   `inputs.testUniverseHash` binds the normalized file set, runner identity,
   and hashed configuration dependencies. Those dependencies include absent
   root candidates, nested workspace configs, Python collection hooks, and the
   bounded static closure of local or package-imported config helpers and setup
   files; creating or editing any of them forces remeasurement. Evidence that
   predates this hash, or whose hash
   changed, is readable but never reusable for a current native discovery run.
   A custom `--runner-cmd` has no native listing; its `testUniverseHash` binds
   the static file set **and the parsed command argv**, so a changed command
   is a changed universe and never reuses a verdict the old command measured.
   Reformatting whitespace that parses to the same argv is not a change. Only
   the hash is recorded, never the command text.
   When several configured runners list defenders, exact manifest membership
   assigns each file. An owned runner takes precedence over the project runner;
   competing owned runners or a declared defender absent from every manifest
   are precondition failures, never heuristic routing decisions.

   The explicit `node-test` adapter uses Node's native collection with test
   bodies excluded by a never-matching name pattern. Collection still loads
   test modules and may run their top-level code; a load error, incomplete
   collection or budget expiry refuses discovery. An injected child preload
   records each actual entry file before project evaluation, so imported test
   declarations cannot masquerade as additional entry files. No filename
   fallback or inferred npm-script configuration is permitted. This adapter
   supports plain JavaScript under Node's default collection, without custom
   loaders, `NODE_OPTIONS` or `NODE_PATH`; it is never selected by `auto`.
   Each confirmation uses fresh, isolated Node test processes under the
   existing worker ceiling. On Node22.8+, Node24 and Node26, a single selected
   entry can run inside one fresh process through a reporting preload and the
   public in-process API; Node evaluates the actual CLI entry, preserving
   CommonJS `require.main`, ESM `import.meta.main` and argv identity. This process
   serves no other entry or confirmation. Discovery, multiple
   entries and other runtime families retain the isolated controller/worker
   route. Single-entry execution preserves ordinary tests beside `.only`,
   records entry provenance before evaluation, monitors entry-load failures
   after test registration, and publishes only at process exit when no
   out-of-test failure or incompatible exit code occurred. A complete stream
   cannot turn a later exception, rejection or retained-handle timeout into a
   kill. Report and entry destinations are captured before project evaluation;
   project environment edits cannot redirect these owned outputs. Both routes
   bind their implementation to native discovery identity.
   Reports count executed test results, not individual
   assertion calls: suite and file-container summaries are not extra tests,
   and skipped/TODO results cannot establish a green defender by themselves.
   A test-body failure counts as a rejection; a load error, hook failure,
   cancellation or timeout never counts as an assertion kill. Malformed or
   unfinished reports are load errors. Evidence names `node-test`, records
   `source: builtin` and the actual Node version, and binds the executable and
   reporter strategy to its discovery hash. Another framework's evidence
   cannot supply its confirmations. Native module-mocking configurations are
   outside this adapter's initial admission boundary.

   Static string literals are conservative dependency candidates, not proof
   of a filesystem dependency. Missing candidates and ordinary directories
   (including `/` in URL bases and string separators) are ignored. An existing
   candidate file outside the project, or a candidate symlink, is rejected.

14. **Barrel resolution follows symbols, not module reachability.** Automatic
   discovery may traverse a re-export chain only for the binding the test
   actually imports. Importing an unrelated symbol from a broad barrel does
   not defend every file the barrel exports. Renames, explicit exports and
   star exports are resolved deterministically; type-only paths do not count.
   Ambiguous origins, unsupported runtime-generated exports, graph-limit
   exhaustion, and originless cycles are `unverifiable` with reason
   `defender-discovery-indeterminate`, never `nocover`. A declared
   `defendedBy` remains authoritative. `inputs.discoveryHashes` binds every
   candidate test, intermediate barrel, and resolver-configuration file
   consulted by automatic discovery. Negative candidates are dependencies too:
   editing a previously unrelated test so it begins importing the target must
   invalidate an earlier `nocover`. Absent or changed dependencies force
   remeasurement.

15. **Fault injection is one method, not the definition.** A claim declares
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

## Per-run and whole-command budgets are different

`--budget` remains the wall-clock ceiling for one runner invocation. An
optional `--command-budget` is a cooperative deadline for the complete
`probe`, `sweep`, or `replay` measurement. Every asynchronous child runner and
discovery process is given no more than the command's remaining time, and the
deadline is checked again at stage boundaries and immediately before any
result is written. Synchronous filesystem, Git, parsing, and cleanup work is
not preemptible in portable Node.js and may finish after the nominal deadline;
that overrun grants no authority to publish a result.

Exhausting the whole-command budget is not a test verdict and is never a
successful partial measurement. The command exits `2` and writes no new
result document; any previous document remains untouched. Cleanup may finish
after the deadline, but no record from the incomplete operation becomes
evidence. This is deliberately stricter than a per-run timeout: publishing
the completed prefix would let the unattempted suffix look clean.

Timeout cleanup is best effort, not portable process containment. TestGuard
hard-kills the runner's original process group and every descendant still
attributable through the process table. A daemon that detached, reparented,
and disappeared from that ancestry before timeout may survive, so timeout
diagnostics state `cleanup-unverified`. Such a run remains a timeout and never
becomes evidence of detection. Daemonizing or untrusted commands require an
OS or container boundary that TestGuard does not claim to provide.

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
| `nocover` | no test imports the reverted files, **and at least one test file remained to ask**. Worse than `blind`: nothing was even tried. |
| `unverifiable` | the revert did not apply, configured or symbol-level defender discovery was indeterminate (`defender-discovery-indeterminate`), the suite failed to load, it timed out, or removing the fix's own test left **no test file at all** (`the-fix-shipped-the-only-test-file`). Carries a `reason`. |
| `flaky` | the runs disagreed. A flaky failure reads as "the suite caught it", so flakiness biases this metric **optimistically** — mixed runs are never `caught`. |

Two rules that follow:

1. **One patch, one row.** De-duplicate by `git patch-id`; a dual-branch
   topology carries the same fix under two or three shas, and counting it
   twice corrupts the corpus a calibration is computed from.
2. **The fix's own test is removed before the run.** It proves nothing about
   what the suite knew before the fix existed.
3. **If that leaves no test file, the run is `unverifiable`, not `nocover`.**
   Removal takes the whole FILE, so on a project with few, large test files it
   also removes tests that pre-dated the fix and might have caught the bug. The
   suite the measurement needed no longer exists, so nothing can be concluded.
   `nocover` is a statement about the PROJECT — "no test exercises this" — and
   using it here would charge the project, in the calibration, for evidence the
   method itself destroyed.

`caught`, `blind` and `nocover` are measurements and enter the calibration
ratio: `caught` as a hit, the other two as misses. `nocover` counts as a miss
because it is one — the worst kind. Leaving it out would let a project with
**no tests at all** for a subsystem score better than one with weak tests,
since its worst outcomes would leave the denominator before the ratio is
taken; Stryker and PIT count no-coverage mutants against the headline score
for the same reason. `flaky` and `unverifiable` are failed measurements and
enter neither side — which is why rule 3 above matters: a run with no test
file left is a failed measurement wearing `nocover`'s clothes, and left
unclassified it would inflate every miss rate computed from the corpus.

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

### Intent-first scaffold authoring

Unannotated generated draft groups use unfinished `TODO-CLAIM-N` identifiers,
not file/function-shaped names. Allocation is deterministic in scan order and
reserves explicit annotations and supplied existing IDs before choosing ordinals.
It never copies unrelated existing metadata into a generated placeholder. Explicit
claim IDs/annotations retain their existing behavior; neither annotations nor
placeholder IDs authenticate intent. Grouping remains mechanical candidate
organization, not invariant ownership. Sweep's pooled allocator keeps repeated
per-file placeholders distinct without changing fault content. Existing claims
and recorded evidence are not renamed. The claims schema/validator is unchanged:
these are valid draft IDs and still require supplied intent and review/probing.

Explicit `scaffold <source...> --into <existing-draft.json> --claim <ID>` appends
mechanically derived faults only to that existing selected claim. Preview JSON
is a conforming claims document (the existing claims schema and validator), not
verification evidence. `--json` creates no files, locks or recovery. Without it,
only the explicitly selected disposable draft is updated; unchanged repeats
preserve exact bytes/mtime. Supplied statements/origins/metadata and existing
faults/sibling claims remain intact. Review and probe are still required.

`--into` is scaffold-only, singular and requires one nonempty existing claim ID
and at least one source. Repeated/comma selections, `--out`, `--claims` and any
explicit unrelated option refuse with usage exit 3 before reading/writing.
Help/version retain their normal early-exit behavior. Ordinary scaffold remains
one-file; annotation `--apply` retains its separate claims-only meaning.

Refuse canonical `testguard.claims.json` names and built-in evidence/baseline
destinations, unsafe aliases/symlinks/hardlinks/nested projects and nonregular
inputs. Admission limits are 32 sources, 2 MiB per source/draft, 16 MiB aggregate
source bytes, 4096 generated proposals and 2 MiB serialized output. Caps refuse,
never truncate proposals. These are not whole-command performance guarantees.

Changed drafts require a cooperative owned exclusive lock, current input replay,
external private original/started/result recovery journals, nofollow descriptor
publication through `writeSpecDoc`, short-write handling, fsync and exact
byte/schema/path/source verification. Refusal, stale inputs, partial writes,
verification or cleanup/journal failure exit 2, report recovery when available,
and never print updated success. No automatic rollback, stale-lock reclamation,
atomic multi-file snapshot or power-loss transaction is promised. Exit 0 means
authoring completed, not defended coverage. Private recovery is not evidence.

Sweep pools per-file drafts before selection. Repeated claim IDs from equal
basenames/functions or annotations do not merge unrelated claims: reserve all
original IDs, then allocate unused numeric suffixes to collisions in full
target-path/original-ID order, within the existing 128-character limit. Metadata,
fault IDs, injection anchors and defenders are preserved. Drafts, selected probe
claims and finding lookup share these identities. This affects fresh collision
cases only; existing documents, verdicts, caps and exit rules remain compatible.

Scaffold's mechanically generated new claims declare `source.kind: inferred`,
including proposals grouped by an annotation. Their TODO asks for intended
observable behavior from a requirement, ADR, bug or incident: inputs, expected
outcome and forbidden outcome. Existing supplied claim metadata retains its
statement and declared origin under the existing `--claim` rules. Derived fault
provenance remains derived. No automatic source promotion or canonical write.

Human CLI, status authoring actions and the installed skill hand off independent
intent authoring. Record a supplied source kind/ref; when unavailable keep
inferred. References and annotations do not authenticate intent and are never
fetched. Passing tests do not establish independent intent. State, next action,
verdict and exit-code semantics are unchanged; this is authoring guidance.

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
7. **A descendant claims file defines a separate project.** The first
   descendant directory on a changed file's path with a valid, regular,
   non-symlinked `testguard.claims.json` owns that subtree. Invalid or unreadable
   markers fail evaluation; they cannot hide unclaimed files. Parent gate and
   status report the delegation as optional `nested` entries with project and
   file paths relative to the parent, and instruct the operator to run that
   project's gate. Delegation is not coverage, an ignore reliance, or proof
   that the child passed. Parent source-surface counts omit these subtrees.
   Removing the marker restores parent evaluation. The accounting identity is
   `changed = evaluated + excluded.length + sum(nested[].files.length)`;
   `--strict` still fails a non-empty change with zero parent evaluation.

Exit codes: `0` every changed parent-owned source file is claimed or excused
(or nothing changed); delegated projects still require separate child gates.
`1` at least one uncovered file (or strict mode over an
all-excluded or all-delegated change); `2` the change cannot be evaluated (unresolvable
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

`probe --allow-empty` is an explicit adoption exception for a valid claims
file containing zero claims, with no `--claim` selection. It exits `0`, says
that verification was skipped, and writes no evidence or baseline. Its JSON
output is the existing `no-claims` status document, without run metadata;
it never reports a clean measurement. Missing or invalid claims still fail,
and selected claims cannot be silently skipped. Run `gate` separately to
enforce coverage of changed files during adoption. Integrations must opt in.

### Explicit declared-origin policy result contract

Optional `originPolicy` on evidence, status and brief (and status's probe `run`)
records an explicitly selected eligible-kind set, not authenticated independence.
Legacy absence is not a pass. `probe --require-origin <kinds>` selects a
repeatable comma-separated nonempty set from the closed source vocabulary.
It requires a complete current-project run with confirm >= 3 and refuses
`--claim`, `--allow-empty`, explicit `--ref` and `--ignore-dirty` as usage errors
before loading or writing. No policy is inferred when the option is absent.
After measurement, the command reloads current claims and collects the current
native runner universe under the same command budget, then binds targets,
resolved defenders and current discovery dependencies. Missing bindings or
discovery failure yields unavailable; custom/static runner universes cannot
certify this boundary. Expired command budgets still write no partial result.
This is point-in-time admission, not an atomic filesystem snapshot. Stored
results are not freshness authority. Offline status reuses only the recorded
eligible-kind selection, recomputes current declarations/complete identities,
and marks freshness unavailable without executing native discovery. This is
an audit projection, not implicit activation of a new gate: the existing
status state, next action and exit remain unchanged. Briefs preserve the
recorded policy before baseline filtering or item caps, labeled recorded-run
only and not current freshness. No absent policy is synthesized. A zero-item
cap cannot turn unproven faults into an all-defended message.

The closed result carries `state` (`passed`, `failed`, `unavailable`), sorted
unique `eligibleKinds`, current `claims`/`faults` denominators, sorted unique
`ineligibleClaims`, unique `nonKilledFaults` (`claimId`, `faultId` only), and
sorted unique `unavailableReasons`. References and paths are excluded.
Refusal reasons require unavailable; otherwise any ineligible claim or
non-killed fault requires failed. Only a nonempty failure-free universe can
pass. Baseline debt and severity floors cannot suppress policy failures.

Evidence validation binds actual non-killed identities, and, for an available
policy, unique recorded denominators, recorded eligibility, unmixed origins and
confirmed injection. Validation cannot authenticate current metadata or disk
freshness: evaluation must separately bind the complete current fault universe
and existing input freshness. Projected status/brief bind denominators, not
hidden source declarations. Brief policy describes its recorded run only.
Completed probe JSON with unavailable policy exits 2; failed policy or ordinary
new findings exits 1; passed policy without ordinary findings exits 0.
Partial/provisional invocations cannot carry an origin policy.

## Read-only authoring input (candidate)

`authoring-input` is metadata-only inspection, never claims or evidence. Its
closed purpose/verification/next fields explicitly state that verification was
not performed and independent intent remains to be supplied. Documents expose
only bounded project-relative file/hash/byte metadata, not text or absolute
roots. A digest or schema-valid report does not authenticate intent or freshness.

Fix inputs retain exact same-width commit/parent/path identities, untrusted
single-line subjects, selected root/nested scope and full partition accounting.
Visible rows exclude private/delegated names; their count stays in the total.
Deleted and unsupported rows cannot become supported source. Validators reject
duplicate/unsafe/private paths, inconsistent status/mode/zero-ID relations,
disposition/count mismatches, unsafe subjects and resource overruns. Empty
documents/inventories are admitted input metadata, not successful verification.
Readers cannot infer actual history completeness or current input admission
from shape alone; the runtime must use admitted local inputs without promotion.

`scaffold --from-document <local-text-path>` or `--from-fix <full-commit-ID>`
selects exactly one read-only authoring input. Both token dispatch and direct
handler entry reject repetition, mixed modes, positional sources and unrelated
explicit options (only JSON/help/version may accompany selection). Normal
help/version early exits remain unchanged. Usage refusal exits 3; input admission
or validated planning failure exits 2 with no success stdout. Success exits 0
for inspection only, never coverage. Both JSON and human modes are stdout-only.
JSON uses the validated metadata-only report; human rendering omits text,
subjects, absolute roots and historical filenames while retaining full fix
partition counts. Both name verification as not performed and require supplied
independent intent before reviewing/probing faults. One elapsed budget covers
input reads and validated serialization; scope resolution never retries with
fresh time. Existing ordinary scaffold/append/probe behavior is unchanged.

## Resource controls and measurement

Built-in runners default to one worker. `--workers N` raises the worker ceiling
for Vitest, Jest and Playwright; `--serial` overrides it to one. Python remains
serial and disables pytest-xdist without installing or enabling any plugin.
Faults and mixed-runner partitions remain sequential. This is a worker ceiling,
not OS CPU/memory containment; test-created threads, native libraries and custom
`--runner-cmd` commands manage their own concurrency. Native discovery is bounded
and uses one worker where applicable.

Runner stdout is drained without retention; stderr retains only its last 65,536
characters. Complete JSON reports are read under the existing 16 MiB discovery
report admission limit. An oversized, unreadable or incomplete report is an error,
never an assertion kill. No confirmation count or verdict rule changes.

Cancellation terminates only registered children and their attributable process
trees, waits up to one second for close, restores live mutations and removes the
registered scratch worktrees. It exits 130 without publishing partial evidence.
Reparented daemons remain outside the portable containment guarantee. Git
subprocesses have a 30-second hard deadline; the whole-command budget remains
cooperative around synchronous setup, and bounded OS cleanup can outlive it.

Optional `run.measurements` records monotonic elapsed time, fresh runner execution
time, invocation count and remaining setup/discovery/other overhead. Each real
runner invocation is charged once, including negative controls and mixed-runner
partitions; reused records and cached baselines create no invocation charge.
`elapsedMs = runnerMs + overheadMs`. Optional `run.workers` records the built-in
worker ceiling and must be one for serial execution; custom commands omit it.
Native evidence reuse requires the same recorded worker ceiling and serial policy.
Older native evidence with no worker ceiling is remeasured; native and opaque
custom-command policies are not interchangeable.
Every reuse also requires the same recorded `run.runner`: name (the engine that
ran, so pytest and unittest differ), version and `source`. `source` is recorded
for every resolved runner — `project` (the project's package, its virtualenv,
or an interpreter named by path), `path` (an executable found on PATH,
including a bare command name given to `--python`) or `builtin` — and is absent
only for a custom command, which resolves nothing. Evidence that recorded no
runner, or a different one, is remeasured.
`status.cost.measurements` copies these measurements when available. Historical
`totalMs` and cost gates retain their existing record attribution, including
reused durations and repeated shared baseline durations. Older evidence has no
measured breakdown; consumers must not infer it from record totals.

The existing Python interpreter cache is reset at probe and replay entry and
reused within that invocation. Uncached adapter resolution consumes the same
live per-run deadline as test execution.

The regression suite caps outer concurrency at two workers in CI. Interactive
runs reserve one available CPU and use at most two workers; a two-core machine
therefore uses one. Nested built-in runners retain their one-worker default.
