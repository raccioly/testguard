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

One prefix is reserved. A `ref` that starts with `req:` is a structured
requirement reference, `req:<spec-id>#<requirement-id>`, with `<spec-id>`
matching `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and `<requirement-id>` matching
`[A-Za-z][A-Za-z0-9._-]{0,63}`. It must be declared with kind `spec`.
Validation rejects a malformed one at `/source/ref` and one under another kind
at `/source/kind`; it is never degraded to opaque, because a typo would
otherwise read as "no evidence for this requirement". Every other `ref` stays
opaque. A structured reference is still a declaration. TestGuard does not
resolve it, fetch the spec or check that the requirement exists. A consumer
that keeps a requirement index, such as DocGuard, compares
`<spec-id>#<requirement-id>` exactly against its own keys. `requirementRef()`
in `spec/lib/origins.mjs` parses the same pattern the shared
`$defs/claimSource` declares. Older readers accept the form as an opaque string,
so adopting it needs no upgrade; only readers with this rule catch a malformed
one. The reference is claim metadata: editing it makes saved evidence for that
claim stale, as any source edit does. Fingerprints, verdicts and gates do not
change.
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
| `killed` | Fault applied; every one of N probe runs failed in a test body (by assertion or by an exception the fault provoked; rule 3), on a defender set that was green N/N unmodified. Carries `detail.killKind`. | no |
| `survived` | Fault applied; every one of N probe runs passed. The claim is **unproven**. | **yes** |
| `nocover` | No defending test exists: the declared globs resolve to nothing, or no test imports the subject. Worse than `survived` — nothing was even tried. | **yes** |
| `unverifiable` | The claim could not be probed: the fault's anchor is missing or ambiguous, configured or symbol-level defender discovery was indeterminate (`defender-discovery-indeterminate`), its defenders failed to load (`defenders-failed-to-load`), probing it threw (`probe-error`), or the defenders do not execute the subject at all (`subject-not-executed`). Carries a `reason`. `defenders-failed-to-load` and `subject-not-executed` also carry `detail.message`: the runner's own first informative error line, or, for a defender set that stayed green with the subject broken under a Playwright config that declares a `webServer`, a note that the server may have been reused from another tree (and, when one is still listening on the config's literal port after the run, that it was). A run is an `error` whenever a test file failed to load, nothing was collected, or the runner reported an error of its own (a Playwright global setup or teardown, `webServer` or reporter error) even when every test passed; it never carries no message. A loud, gating verdict — a claim that cannot be probed is not "skipped", it is undefended until someone fixes the fault or the defenders. Never confused with `flaky-defender`, which requires tests that *ran*. | **yes** |
| `timeout` | Probe run exceeded its budget. Not counted as a kill; the pessimistic reading is the safe one because flakiness biases the metric optimistically. | **yes** |
| `fault-invalid` | The replacement does not load or compile (`replacement-does-not-compile`, `suite-failed-to-load`), or — under `--typecheck` — parses but does not type-check (`replacement-does-not-typecheck`, rule 16). A bad fault, not a detection. | **yes** |
| `flaky-defender` | Defenders were not green N/N on unmodified source (`defenders-not-green`), or the N probe runs disagreed with each other (`inconsistent-probe`). Either way no verdict about the fault can be trusted; fix the defenders first. | **yes** |

Rules that follow from the table:

**The checks run in a fixed order, and the first that applies decides.**
`nocover` (no defender) → `unverifiable` with an anchor reason (the fault
cannot be applied) → the type check's `fault-invalid` or `timeout` (rule 16)
→ `flaky-defender` (rule 1) → the fault's own result (rules 2–5, 12). Where
two findings both hold, the worse and more actionable one is reported, and
that is the order above: **`nocover` precedes an invalid anchor.** Both gate,
but `nocover` is the worse finding (nothing can be tried, whatever the fault
says; every rendering ranks it above `unverifiable`) and its repair, a test
that imports the subject, is needed whatever the anchor's repair turns out to
be, while repairing the anchor alone leaves a fault nothing can detect. A
record that reports an anchor reason (`anchor-missing`, `anchor-ambiguous`)
for a fault with no resolved defender does not conform. The verdict function's
check order is this rule.

1. **Green baseline first.** Defenders run N times unmodified before any fault
   is applied. Anything short of N/N pass is `flaky-defender` and stops there.
2. **Confirm over N runs.** `killed` and `survived` both require exactly N
   probe runs, all agreeing. Default N is 3. **Fewer than three runs is
   provisional**: the evidence declares `run.provisional: true`, every
   rendering marks the verdicts as unconfirmed, and a provisional run is
   never frozen into a baseline. Provisional runs exist for the fix loop —
   a fast signal while writing a test — not for a gate.
3. **Only a test body rejecting the behaviour kills, and a kill says how.** A
   test that fails by assertion — or by an exception the fault provoked inside
   it — counts. A timeout does not, and a suite that fails to load does not:
   neither is evidence that the suite defends the claim.

   *Two kinds of kill.* Every failed test is exactly one of: a timeout, an
   **assertion** failure, or an **exception**. The runner reads which from the
   error's structured identity — an `AssertionError` (by `name` or by
   `code: ERR_ASSERTION`), a jest `matcherResult`, a framework's own failed
   `expect` step, a Python `AssertionError` or pytest `fail`/`raises` outcome —
   and never from message wording. An error whose shape the runner cannot read
   is an exception: the pessimistic side. A test with several errors is an
   assertion when any one of them is. The testRun records both counts,
   `assertionFailures` and `exceptionFailures`; a run kills when their sum is
   above zero, so the default verdicts are exactly what they were before the
   split. A `killed` record then carries `detail.killKind`, derived from its N
   probe runs: `assertion` (every run had at least one assertion failure),
   `exception-only` (no run had one: the code threw and the suite went red,
   which proves the suite **reaches** the code, not that it **checks** it), or
   `mixed`. Evidence written before the split has neither field.

   *The policy.* `probe --require-assertion-kill` (also on `admit`) fails
   when any `killed` record is `exception-only` or carries no recorded kind:
   exit 1, the verdict still `killed`, the policy result stored as
   `assertionPolicy` and rendered beside the record. It adds no verdict and
   never changes one. `mixed` passes. `status` and `brief` count exception-only
   kills as a named weakness beside the co-authored count.

   *Known limits, stated so they are not rediscovered.* A defender that
   asserts only that the code does not throw (`expect(fn).not.toThrow()`,
   `assert.doesNotThrow`) is an assertion, and a kill by it is an assertion
   kill. An `AssertionError` raised by the code under test itself (an internal
   `assert`) is indistinguishable from the test's own and reads as an
   assertion, the optimistic side. jest keeps only a rewritten `message` for
   a `node:assert` error, which is the same shape as a plain object thrown as
   `{ message }`; such a lone `message` is an assertion only when the error
   header (first line of the matching `failureMessages` entry, never a stack
   frame or quoted text) names `AssertionError` or is jest's own assertion
   header, `assert.<fn>(` or `expect(`; otherwise it is an exception. Playwright
   exposes only the failed `expect` step and the error's class name to a
   reporter; a failed `expect` step the test then swallowed, before failing
   some other way, is misread as an assertion. A custom `--runner-cmd`
   reports what its jest-compatible report carries; without `failureDetails`
   every failure is an exception, and when that is the only reason (every
   exception failure of every run was one the runner gave nothing to classify,
   counted as `testRun.kindNotReported`) the record says so with
   `detail.killKindReason: "kind-not-reported-by-runner"` and the policy
   repeats it per kill: the kill is exception-only by default, not by
   evidence that the suite is hollow. It still fails the policy.
 Tools parse the runner's
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
   exception raised by the test body both kill (as an assertion and as an
   exception respectively), because both are the suite rejecting the
   behaviour; a collection error — a module that will not
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

   **What the target and defenders import is an input to reuse.** A verdict
   is about the code the defenders run, and most of that code is not the
   target file or the test file. Evidence records
   `inputs.dependencyHashes`: content hashes of the transitive project-file
   import closure of the fault target and of every resolved defender, plus
   the lockfiles, package manifests and runner/compiler configuration files
   present at the project root. JavaScript and TypeScript follow every static
   import, re-export, literal `import()`/`require()`, and module named to a
   test framework's `mock`/`importActual`/`requireActual` family (with an
   adjacent `__mocks__` file); an ambiguous resolution includes every
   candidate. Python follows module names, including the packages a module's
   import runs first and every `conftest.py` from the project root down to
   each file. Reuse requires the recorded and current maps to be equal.
   **The closure describes the tree that will be probed.** Only files git
   tracks at the probed commit are project files for the closure — plus
   untracked files git does not ignore when the working tree is snapshotted
   (`--include-dirty`) — which is exactly what the scratch worktree contains.
   An ignored directory (a deployment bundle holding copies of third-party
   packages, a vendored build) is never indexed or followed: a Python module
   or a JavaScript file there does not exist for the closure, and an import
   that reaches only such a file is unresolved (indeterminate), as it is in the
   scratch tree. Root manifests are hashed under the same rule. So `probe`
   (in the scratch tree), `probe --changed`, `status`, `gate` and the
   origin-policy freshness check compute the same closure for the same commit.
   Outside a git work tree every file on disk counts.
   **A workspace package is followed like a relative import.** A bare
   specifier that names a package the repository declares as a workspace
   (root `package.json` `workspaces`, `pnpm-workspace.yaml` `packages`), or
   that Node would resolve through a `node_modules` symlink whose target is
   repository source (inside the repository and not under any `node_modules`:
   a workspace, `file:` or `link:` dependency), is code the defenders run. The
   closure includes that package's `package.json` and follows the entry its
   `exports` names (every condition except `types`, since which one loads
   depends on the caller; a subpath map with `*` patterns), else `main` and
   `module`, else `index`, and on from there. Such a package inside the
   repository but outside the project directory cannot be hashed
   project-relative, and an entry that resolves to no file cannot be followed:
   either makes the closure indeterminate (`unreadable-module`, naming the
   specifier). A link whose target leaves the repository, and a package
   installed as a real directory, stay outside the closure.
   **An alias is read, or the closure says it could not be.** Aliased
   specifiers resolve through tsconfig/jsconfig `paths`, package.json
   `imports` and vite/vitest `alias`. A vite/vitest alias value is read from
   the config's tokens, never by running the config, over a closed grammar of
   path expressions: a relative string, `fileURLToPath(new URL('./x',
   import.meta.url))`, `new URL(…).pathname`, `resolve`/`join`/`dirname` (bare
   or as `path.…`) over `__dirname`, `__filename`, `import.meta.dirname`,
   `import.meta.filename`, `process.cwd()` and string literals, and a
   top-level `const` bound to one of those. An alias whose key is known but
   whose value is outside that grammar resolves its specifiers to nothing, so
   a closure that uses it is indeterminate (`unreadable-module`); an alias map
   that cannot be read at all (a variable, a spread, a computed key, a RegExp
   `find`) does the same for every bare specifier. Neither refuses the run, and
   neither is dropped: a dropped alias made its specifiers look like packages,
   outside the closure.
   **Ordinary export forms are read, not refused.** A module whose exports the
   reader cannot read is `unsupported-syntax`, which makes every importer's
   closure indeterminate, so the reader covers what projects ordinarily write.
   TypeScript type-only and ambient forms (`export interface`, `export type`,
   `export type { … } from`, `import type`, `export declare …`,
   `export as namespace`) declare no runtime binding and load nothing; `export
   enum`, `export const enum`, `export namespace`/`module`, `export abstract
   class`, generator functions, decorated classes, `satisfies`, several
   declarators and destructuring declarations export the names they declare.
   `import type from 'x'` is a default import named `type` and loads `x`. A
   CommonJS `module.exports = { … }` exports each key: a shorthand or a name is
   that binding; `require('x')` is module `x`, `require('x').y` its export `y`,
   `ns.y` the export `y` of an imported namespace; any other value is computed
   in the module, as `exports.X = call()` is. A spread, a computed key, an
   accessor, a member of a named import, and a module load inside an
   expression (`wrap(require('x'))`) stay `unsupported-syntax`: when in doubt
   the closure is indeterminate, never smaller.
   When any import cannot be followed — a dynamic import, `require`,
   `import_module` or `__import__` whose argument is not one string literal; a
   project-relative or aliased specifier that resolves to no file; a module
   the lexer cannot read; a graph over the resolver limits — the record
   carries `inputs.dependencyClosure: "indeterminate"` with the reasons in
   `inputs.dependencyIssues`, and is never reused: it is probed again every
   time. A record without `dependencyHashes` predates this rule; it stays
   readable and is never reused. A record carrying `reusedFrom` and an
   indeterminate closure does not conform.

   **One live baseline licenses every carry-forward.** No hash sees the
   environment: installed packages, the interpreter, a data file a test reads,
   a setup or global-setup
   file a runner configuration names by string rather than imports, a lockfile
   above the project directory in a monorepo. So before a prior record
   with a non-empty defender set is carried forward, that defender set runs
   once on unmodified source. That run is the first run of rule 1's shared
   baseline, so it costs one run per defender set per command, and a fault
   probed after all pays nothing twice. Anything other than a green run
   means no reuse: the fault is probed in full, and rule 1 decides the
   verdict. The run is counted in `run.measurements.reuseBaselineRuns`.

   `status` and the origin-policy freshness check compute the same closure
   and apply the same comparison, so a changed import makes `status` stale
   and makes origin-policy inputs unfresh. An indeterminate closure is never
   fresh for the origin policy, which is then `unavailable`; `status` does
   not call it stale on that ground alone, because re-probing cannot make it
   determinate and an agent would loop. `--no-reuse` is unchanged.

   **The instrument is part of the reuse key.** Evidence records
   `run.instrument`: the TestGuard version that decided its verdicts (equal to
   `tool.version`) and a digest of the configuration that shapes how
   defenders are found and run and is not hashed per record — the resolver's
   alias sources (tsconfig `paths` through `extends` and `references`,
   vite/vitest `resolve.alias`, package.json `imports`) and the root runner
   configuration and lockfiles. Evidence from another version or digest, or
   with no `run.instrument`, is readable and never reusable: a newer tool may
   decide verdicts by different rules. `status` applies the same rule and
   reports it as one stale line for the whole document — another version, or
   a changed configuration digest — so `status` never calls evidence fresh
   that the next probe would re-measure in full.

   **Reuse is a trust decision, and the evidence says how much of it there
   was.** `run.reuse` counts the records carried forward (`reused`, each with
   `reusedFrom`) and the records measured (`measured`); `probe --json` copies
   it. Reuse trusts the previous evidence file: a hand-written record whose
   hashes match is indistinguishable from a measured one. **A gate over
   authors who can write the evidence file must run with `--no-reuse`.**
   `--no-reuse` also turns off convergence's carrying (see
   [Convergence](#convergence)).

   Evidence is written atomically — an exclusive temporary file in the same
   directory, then a rename — so a run killed mid-write leaves the previous
   document or the new one, never a truncated file a later probe reads as
   prior evidence.

   `inputs.targetHash` and `inputs.defenderHashes` keep their meaning;
   `inputs.dependencyHashes` sits beside them. A consumer that judges
   freshness must compare all three: the first two alone miss every change
   to what the target and defenders import.

9. **The fault must be the code that ran.** A green baseline proves the
   harness is not reporting everything as broken. It proves nothing about the
   opposite direction: a fault the interpreter never executes leaves the
   baseline green, every verdict `survived`, and a report that reads as a
   devastating finding while being entirely false. A tool that can tell which
   file was actually loaded must check it while the fault is applied, and must
   **refuse the run** when the subject was loaded from outside the tree being
   probed — in Python an editable install (PEP 660) registers an import hook
   consulted ahead of every path entry, and a plain install leaves a copy in
   `site-packages`, so this is the normal case, not an exotic one.
   JavaScript has the same hazard in a monorepo: a workspace link
   (`node_modules/@scope/pkg -> ../../packages/pkg`) borrowed into a scratch
   tree resolves to the original checkout's package, so a fault applied in the
   scratch tree is never executed by a defender in a sibling package. A tool
   that probes in a scratch tree must therefore give each tree its own
   layout: every `node_modules` link whose target is repository source (as
   rule 8 defines it) points at the scratch tree's copy of that package, in
   the root install and in each package's own `node_modules`, for npm, yarn
   and pnpm layouts, without writing into the shared install (which may be
   read-only). The fan-out's trees and the serial re-measure tree get the
   same layout. A package's ignored top-level entries (a build's `dist/`) are
   linked from the source package, since the commit does not hold them; a
   fault in its source does not reach them, which the negative control
   (rule 12) reports as `subject-not-executed`, never as a verdict. A link to
   repository source the scratch tree does not contain (an ignored or
   uncommitted package) refuses the run with the precondition
   `workspace-link-outside-tree`, naming the link. When no
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
   defender set. A record whose verdict is `timeout` or `flaky-defender` is
   never reused either: each says the defenders could not be measured on that
   machine at that time (a loaded runner, a nondeterministic suite), and a
   green live baseline today (rule 8) does not make yesterday's timeout
   today's answer. The one exception is a **precondition** failure — the
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
   the project each file is listed under (when the runner has projects), and
   hashed configuration dependencies. Those dependencies include absent
   root candidates, nested workspace configs, Python collection hooks, and the
   bounded static closure of local config helpers and setup files; creating or
   editing any of them forces remeasurement. A bare import that resolves to an
   installed package (its real path is under a `node_modules` directory,
   including pnpm's store and a scratch tree's link to the source install) is
   recorded by package name and the version in its `package.json`, never by
   reading its module files, and never fails discovery for size or file count;
   lockfiles and manifests bind it as well. A bare import that resolves to
   source linked from inside the project (a workspace package) is followed like
   a relative import. Project files keep a scan bound per file, in total and in
   number, and a refusal names the file and the limit. A file that is not a
   module and exceeds the scan bound (a lockfile, a data file a configuration
   names) is hashed in chunks under its own bound and is not scanned. Evidence
   that predates this hash, or whose hash
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

   Vitest `test.projects`: the listing (`vitest list --json=<file>` on vitest 3
   and later, else the text form with its `[project] ` prefix parsed) names the
   projects each file belongs to. A defender runs under every project that
   lists it, one run per project selected with `--project`, and the runs merge
   like the runs of several runners: any load error, timeout or failure under
   any project is one for the defender set. A run never relies on the file path
   alone, because vitest's path filter also matches another project's file whose
   path contains it. A project that no `--project` value selects alone among the
   listed projects is a discovery failure.

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
   of a filesystem dependency. Missing candidates, ordinary directories
   (including `/` in URL bases and string separators) and strings too long to
   be a path are ignored: a string that names a directory (`new URL('./src',
   import.meta.url)`) is never read as a module through its index file, only a
   `references` entry's tsconfig/jsconfig is taken from it. Symbolic links are
   followed while the real path stays inside the project; containment is
   decided on the real path. An existing candidate file whose real path is
   outside the project, a link (or dangling link) that leaves it, and a link
   cycle are rejected, naming the path. An import in a config or config
   dependency that the project's alias configuration maps (rule 8) is followed
   to the project file it names, never resolved as a package; one the alias
   maps to nothing is not followed here and never refuses the run.

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

16. **A replacement the compiler refuses is not a fault.** Under
   `--typecheck[=<cmd>]` the project's own type checker judges every fault
   before any test runs: the fault is applied, the checker runs, the fault is
   restored. Diagnostics that the unmodified tree did not have make the verdict
   `fault-invalid`, `detail.reason` `replacement-does-not-typecheck`,
   `detail.typecheck` `diagnostics` and `detail.message` the first diagnostic;
   `baselineRuns` and `probeRuns` are empty, because no test run was spent. A
   check that exceeds its budget is `timeout` (`typecheck-timed-out`, never a
   pass). The type check precedes rule 1's baseline because it is a property of
   the fault, not of the defenders; `nocover` and an anchor that does not hit
   still come first, since there is no fault to check.
   **The unmodified tree is checked first** and must be clean. A tree that
   already fails cannot be used to judge a fault, so the run is a precondition
   failure (exit `2`) that names the first diagnostic and writes no evidence.
   So is a checker that cannot run: no `tsconfig.json` and no command, a
   `typescript` that cannot be resolved from the project, a `tsc` that cannot
   read the configuration. A check that was asked for and cannot be made is
   never a skipped check. A checker that dies mid-run without a diagnostic is
   `unverifiable` (`probe-error`) for that fault, never `clean`.
   The checker is the project's own `tsc --noEmit -p tsconfig.json`, never a
   bundled compiler, or a custom command that is an argv and never a shell
   string. The default runs `--incremental`; its build-info file lives under
   the scratch area, is snapshotted after the baseline check, and is restored
   before and after every fault, so one fault's diagnostics never reach the
   next. A target the checker does not read (a `.py` file, a `.js` file the
   project does not check with `allowJs` and `checkJs`, a `.ts` file the
   tsconfig's program does not contain, any custom command's non-TypeScript
   target) is recorded `detail.typecheck: "not-applicable"` and probed as
   before: `clean` is never said about a file the checker did not read. (A
   custom command cannot say what it reads, so for it only the extension
   decides.) A program with no project file is a precondition failure for the
   default command: nothing could be judged. A checked fault that stays valid
   is `clean`.
   **The checker is an instrument.** Evidence records
   `run.typecheck: { commandHash, version }`: a hash of the command's identity
   (its flags, or the custom argv) and the checker's version. It is part of the
   reuse key (rule 8's instrument): a record measured without the type check is
   not reusable by a run with it, and the reverse; so is one measured with a
   different command or checker version. A record carrying `detail.typecheck`
   requires a run that declares `run.typecheck`.
   **Type validity belongs to the whole program**, which no per-fault hash sees
   (a file added elsewhere, or an ambient `.d.ts` nothing imports, can make a
   clean fault invalid). So the project's own `tsc` records, once per run,
   `run.typecheck.programDigest` (#293): a hash of tsconfig.json, the resolved
   configuration (`--showConfig`) and every file `tsc --listFilesOnly` reports
   for the unmodified tree, a package's files by its name and version and any
   other file by its content. Reuse and carrying need the same `commandHash`,
   `version` and `programDigest`, and the run's own clean baseline type check;
   a fault's recorded `detail.typecheck` then stands with no check of the fault.
   A different digest reuses and carries nothing. A record from a run that
   recorded no digest (0.24.0, or a custom command, which cannot list its
   program) is checked again, fault by fault (one check, no test run), and is
   carried forward only if `detail.typecheck` comes out the same; after such a
   run the default command's evidence has a digest. A `diagnostics` record is
   carried forward without any test run, since none produced it. A custom command's
   `version` is best-effort (the command's own `--version` plus the project's
   `typescript` when it resolves); `--no-reuse` covers a checker that changes
   under neither.

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

### Opt-in partial result: `probe --partial-on-budget`

A caller with a fixed time box (an agent loop, a CI step) can opt into a
partial result for `probe` only (`sweep`, `replay` and `admit` refuse the flag;
it needs `--command-budget`, and it is refused with `--require-origin`, whose
policy needs complete evidence). The default above is unchanged. With the flag,
when the budget runs out the run stops starting work, restores and removes
every scratch tree, and writes a document under one rule: nothing that was not
fully measured is reported as measured.

1. **Reached.** A fault whose measurement finished keeps its record, whatever
   order a `--fault-workers` fan-out finished them in. "Reached" is decided per
   record: under a fan-out a record that finished behind an unfinished
   predecessor is kept.
2. **Not reached.** Every other fault — the ones in flight, the ones never
   started, and one waiting for its serial re-measure (a contended record is not
   a measurement) — gets verdict `unverifiable` with `detail.reason`
   `not-reached-within-budget`, no baseline or probe runs, no resolved
   defenders and `defenders.nocover: false`. It gates, so the suffix cannot look
   clean. It is never reusable (`isReusable` refuses the reason) and carries
   no `reusedFrom`. Expiry before any fault is measured (during discovery,
   planning or a baseline) writes a document with zero reached.
3. **A run the budget itself cut short is the deadline.** A child killed at the
   cap of the command's remaining time is not a `timeout` verdict about the
   defenders even if the clock shows a sliver left; the run is over.
4. **Order.** Faults are probed in the caller's order: `--claim` order, else the
   claims file's order. The emitted order is always claim/fault order.
5. **`run.budget`** is `{ limitMs, exhausted, reached, notReached }`, recorded
   whenever the flag is given. `exhausted` is true exactly when a
   `not-reached-within-budget` record exists; `reached + notReached` equals the
   record count, and each count equals the records it names. The validator
   re-derives all of it and rejects a document that disagrees, a not-reached
   record outside `run.budget`, one that has runs or a verdict other than
   `unverifiable`, and an origin policy on an exhausted run. A run that finished
   every fault inside the budget is complete (`exhausted: false`) even if the
   clock ran out while its result was being written: the deadline bounds
   measuring.
6. **Where it goes.** An exhausted document is written to `--out` or
   `.testguard/evidence-partial.json`, never the canonical evidence file (an
   `--out` that names the canonical file is redirected with a warning), and
   `baseline` refuses it.
7. **Exit code.** Never `0`. The gate reads the measured records only (a
   not-reached record always gates and is not counted): when they already hold a
   new gating verdict, or a failed policy, the exit code is `1` and `--json`
   carries `run.failureKind` `unproven+incomplete` with `run.unprovenAtLeast`, the
   count of those verdicts — a floor, since the faults not reached are not
   counted — or `policy+incomplete` for a failed assertion policy alone.
   Otherwise the exit code is `2` and `run.failureKind` is `incomplete`. `run.budget`
   is copied into the `--json` run block.
8. **Per-claim results.** `run.claims[]` reports a claim with a not-reached
   fault as `could-not-verify` with the reason, unless another of its faults
   survived, in which case it is `unproven` (the rule below is unchanged).

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

A baseline command's machine output is the status document plus an optional
`baseline` result, exactly as a probe's is the status document plus `run`:
`{path, frozen}` when it froze one (`frozen` counts the unproven findings it
holds), `{path, restamped}` when it moved an existing baseline's head (the
commit it now names). The document is validated before it is printed. One
document carries at most one invocation result, never both `run` and
`baseline`.

## Ignore and annotations

- An ignore entry excuses a *coverage* or *removal* finding; it never
  removes anything from a probe and never touches a verdict. A probe reads no
  ignore file: a claim that is in the claims file is probed, so an excuse can
  never hide a survivor. A known finding is accepted in a baseline (above),
  which is fingerprinted, counted and reported as baselined. Every entry
  carries a `reason` of at least eight characters; the structured form is what
  an auditor reads. An entry past its `expires` excuses nothing and is
  reported as expired. The kinds, and the only thing each does:
  - `path` — a glob over project paths. Excuses a changed source file from
    the change gate (below); every reliance is reported.
  - `claim` — exactly one claim id. Excuses the removal of that claim, and of
    any of its faults, when claims are compared against an earlier reference.
  - `fault` — exactly `<claimId>/<faultId>`. Excuses the removal of that one
    fault in the same comparison.

  There is no fingerprint kind: suppressing a finding by fingerprint is what a
  baseline does, and a second, uncounted channel for it would let debt be
  accepted where no baseline report shows it. A `claim` or `fault` pattern
  that is not an exact identity is invalid, because it would excuse nothing —
  or, for a `fault` entry without its fault id, the whole claim. A plain
  gitignore-syntax file may be accepted as shorthand for reasonless `path`
  entries.
- A concerns file is read like every other spec document: one that does not
  parse or does not conform fails the command that reads it (exit `2`). It
  never degrades to a concern that matches nothing — a sweep aimed at nothing
  reports clean.
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

## Write boundary

TestGuard writes in a fixed, listed set of places, so a caller that confines it
can provision exactly those. The set is: the **scratch directory**, the
evidence path (`--out`, else `<dir>/.testguard/`), and git's own metadata under
the repository's `.git` (`worktrees/` for each scratch worktree, plus loose
objects when `--include-dirty` snapshots an unstaged tree). Nothing else.
`--scratch-dir <path>`, or `TESTGUARD_SCRATCH_DIR`, names the scratch directory
for `probe`, `sweep`, `replay` and `admit`; the flag wins. Every scratch
worktree, temporary git index, runner report, sidecar reporter file and
per-process runner temp directory lives under it, and the children are given
a `TMPDIR` inside it. Unset, it is the operating system's temp directory, as
before. A directory that does not exist or cannot be written is a precondition
error (exit 2) reported before anything is written; it is never created.

The scratch worktree gets its own `node_modules`, and **no level a package
manager may write is a link into the user's install** (#279). A runner
command can run a package manager in the scratch tree (`pnpm vitest …`
verifies the install and relinks it), so every node_modules-level directory —
the root, each scope, `.bin`, `.pnpm`, `.pnpm/<id>`, its `node_modules`, a
package's own nested `node_modules`, and the same in every workspace
package's `node_modules` — is a real directory in the scratch tree; every
file at such a level (bin shims, install metadata) is a copy; every symlink is
a new symlink to its resolved target, never a link to the user's link; and a
package directory is a read-only leaf. Install metadata that names the
user's checkout by absolute path (pnpm's workspace state) is rewritten to
name the scratch tree. A `node_modules` the checked-out tree itself holds as
a symlink (committed, or captured by an `--include-dirty` snapshot of a
worktree whose `node_modules` links to the main checkout's) is replaced by
this layout. So a tool that writes `node_modules/.vite-temp`, `.vite` or
`.cache`, and a package manager that relinks, write into the scratch tree and
never into the install. Tool cache directories are not carried across.

**The install is checked, not trusted.** Before a scratch-tree run and again
after every scratch tree is removed, each borrowed install is fingerprinted at
the levels a package manager writes (entry names, kinds, link targets, file
sizes and times). A difference refuses the run with the precondition
`install-changed`, naming the paths and telling the user to reinstall; no
evidence is written, because verdicts measured while the install changed
under them describe nothing. Something else changing the install during the
run (the user reinstalling) is refused the same way. The
per-run temp directory also sets `XDG_DATA_HOME` (vitest keeps an API token
there on Linux). Runs against the caller's own tree (the dirty-tree test
discovery, `--in-place`) cannot be redirected: discovery asks vitest 4 and
later for `--configLoader runner` when the install is not writable, and
`--in-place` is documented as writing the tree.

`run.writeBoundary` records signals, never paths: `scratchDir` is `default` or
`configured`; `nodeModulesWritable` is true when any linked install (or
`--node-modules`) could be written as the run started, false when none could,
and absent when none is linked. `installUnchanged` is `true` when the
install fingerprints were compared and agreed; it is never `false` (that run
is refused) and absent when nothing was borrowed or the run was in place. It
does not enter reuse: it is a statement about where the run could write, and
no verdict depends on it.

What is not promised: the tests under probe run the project's own code with the
caller's privileges. The boundary says where TestGuard and the built-in runners
write; it is not a sandbox, and it cannot stop a test from writing elsewhere or
opening a socket.

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

A scoped run (`--claim` or `--changed`) that measured claims carries two
answers. The document's `state` and `next` describe the whole claims file, as
they do for `status`: an invalid anchor on a claim the invocation did not select
is true of the file and stays visible there. `run.scope.state` and
`run.scope.next` describe the selection alone: the same state machine over only
the probed claims, their anchors and their evidence, with everything that
belongs to the rest of the file (`unclaimed-changes`, `no-claims`, the claimed
surface, the origin policy) left out. Either both are present or neither. The
validator refuses a scoped `next` whose `target` is a claim the invocation did
not probe, a scoped state of `unclaimed-changes` or `no-claims`, and a scoped
state on an invocation that measured nothing. Human output leads with the scoped
line and names the whole-file line only when it differs.

## Probing a change

`probe --changed <ref>` measures only the claims a change can have affected.
The change is `merge-base(<ref>, HEAD)` against HEAD, or against the working
tree with `--include-dirty` (tracked edits, staged or not, and untracked files).
Paths are project-relative; a change outside the project directory is not this
project's change. A deletion is a change. A rename or copy contributes its old
path and its new path.

**`--changed auto` (#270).** The base is found offline, in this order: the CI
base (`GITHUB_BASE_REF` as `origin/<branch>`, then
`CI_MERGE_REQUEST_DIFF_BASE_SHA`, then `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`);
the remote default branch, unless it is the current branch's own name; a
differently named upstream; then the branch's own upstream (`@{upstream}`),
whose difference from HEAD is exactly the commits not pushed yet — the pre-push
question. When none is found, or the one found does not resolve to a commit in
this repository (a shallow CI checkout), the run probes every claim, writes the
canonical evidence, and says so on stderr even under `--quiet`, naming the fix
for an unresolvable base; that line is the run's first. Unless asked otherwise,
it never probes nothing, and it never exits 2 for a base it chose itself; an
explicit `--changed <ref>` that does not resolve still does. A branch literally
named `auto` is written `refs/heads/auto`.

`--when-no-base <full|skip|fail>` says what no resolvable base means (#293);
it is valid only with `--changed auto`. `full` (the default) is the behavior
above. `skip` probes nothing, writes nothing, prints one line saying why and
what to run, and exits 0. `fail` refuses (exit 2, error kind `no-base`). The
pre-push block passes `--when-no-base skip`: a git hook never starts a full
probe, which on a large project takes hours; the CI job and the nightly full
probe are the gate. The option governs only a base that could not be found: a
base that was found or named but cannot be measured (it does not resolve, no
merge base, git failed) and any runner failure still exit 2 and fail the push.
A skipped run has no document, so `skip` is refused with `--json` (exit 3).

A claim is **selected** when any of those paths is one of: a fault's target; a
defender, whether the claim names it (`defendedBy`, literally or by glob) or
discovery resolves it; or a file in the import closure of the target and the
defenders (the same closure `inputs.dependencyHashes` records, manifests and
runner configuration included; a workspace package reached through its link
is part of it, rule 8); or the project configuration `testguard.config.json`
(#301), which is an input of every claim whether or not it exists, so a
change, an addition or a deletion selects every claim. It is not a dependency
hash: which of those verdicts really moved is decided by reuse, which compares
the options the file resolves to. A closure that cannot be followed selects the
claim whenever anything changed **anywhere in the repository**, not only in
the project directory: what the closure could not follow may be a sibling
package outside it, and not being able to tell is never read as
"unaffected". The closures are those of the tree the probe will measure (rule
8: tracked files, plus untracked non-ignored ones under `--include-dirty`).
`run.scope.changed.matchReasons` says why each matched claim was selected, in
`matchedClaims` order: `file` (the first changed file that is a target, a
resolved defender, in the closure, or `testguard.config.json`), `glob` (a changed path only a
`defendedBy` glob matches, such as a deleted defender) or `indeterminate`
(with the closure's first recorded issue). It names each matched claim once
and nothing else. `--claim` intersects: the selection is the requested ids that the
change reached, in the order requested. An unknown `--claim` id is an error
whatever the change is.

For a fault whose defenders are **discovered** (no `defendedBy`), the claim is
also selected when a changed path is one of its discovery inputs (#297): a
candidate test file, or a file a candidate imports, as discovery finds them now
or as the claim's evidence recorded them (`inputs.discoveryHashes`; a deleted
candidate is known only there). An edit to any of them can give the claim a
defender, which changes its verdict. Discovery that cannot be followed selects
the claim as an indeterminate closure does. The reason is `discovery`.

Selection has three outcomes, reported in `run.scope.changed.outcome` and
`run.scope.selectedCount`, and they are never confused:

| Outcome | Meaning | `run` | Exit |
|---|---|---|---|
| `determined`, claims selected | those claims are probed | a measured run | the probe's own (0 or 1) |
| `determined`, none selected | the change touches nothing any claim depends on | `exitCode` and `scope` only; `selectedCount: 0`; no evidence written | `0`, or `2` under `--fail-on-empty-selection` |
| `undetermined` | the ref does not resolve (`ref-unresolved`), there is no merge base (`no-merge-base`), git did not finish (`git-timeout`) or git failed any other way (`git-failed`) | `exitCode` and `scope` only; no `selectedCount`; `reason` `{kind, message}` | `2` |

An empty selection says so in a line of its own and is not a pass for the
change: it says no claim was in its way. An undetermined change is not an empty
one and never narrows a run: nothing is probed. Every git call on the selection
path is a named site (`SCOPE_GIT_SITES` in `src/probe/scope.mjs`) and a failure
at any of them is `undetermined`; the test suite fails every site in turn and
pins the list, so a call added without a reviewer deciding what its failure
means does not pass CI.

`run.scope.changed` also carries `files` (every changed path), `matchedClaims`
(the claims the change reached, before `--claim`) and `unmatchedFiles`: the
changed source files no claim's target, defender or closure touches, with the
note `not covered by any claim; absence from the results is not a pass`. This is
the probe-side view of what `gate --changed` enforces; a clean result over a
change whose files are listed there says nothing about those files.

`--changed` measures the tree being probed (HEAD, or the working tree with
`--include-dirty`), so it is refused with `--ref` and `--in-place` (exit `3`):
the selection would describe another tree than the one measured.

A `--changed` run's selection is partial evidence. When the run may converge
(see [Convergence](#convergence)) it updates the canonical file; otherwise it
writes `evidence-partial.json`, which is never a baseline.

**`--explain` (#301).** `probe --changed <ref> --explain` computes the
selection exactly as above and probes nothing, writes nothing and runs no test
discovery: one line per selected claim with its `matchReasons` entry, a count
per reason kind, and the changed source files no claim covers. Under `--json`
the document is the status document plus `run: {exitCode, scope}`, where
`scope` is what a probe would carry with `explain: true`, `probedClaims` empty
and `probedCount` 0; `selectedCount` is the selection, which an explanation
alone may leave unprobed. It never has a `run.id`. A determined change exits
0 whatever it selects (an explanation judges nothing, so
`--fail-on-empty-selection` does not apply); an undetermined change exits 2,
as it does without `--explain`. `--explain` without `--changed` is a usage
error (exit 3).

## Project configuration

`testguard.config.json` in the project directory (#301) holds the defaults of
the options that describe **how** the project's tests run: `runner`,
`runnerCmd`, `python`, `nodeModules`, `typecheck` (`true` is the project's own
compiler, a string the command), `workers`, `faultWorkers`, `confirm` and
`budget`, each standing for the flag of the same meaning. Nothing in it
selects what is probed or shapes output. Schema: `config.schema.json`.

1. **Precedence.** A flag typed on the command line (judged by what was typed,
   never by the parser's defaults), then the environment variable where one
   exists (`TESTGUARD_PYTHON`, `TESTGUARD_NODE_MODULES`,
   `TESTGUARD_FAULT_WORKERS`; empty is unset), then the file, then the
   built-in default. `--no-config` ignores the file. A key applies only to
   the commands whose flag exists: `typecheck` to `probe` and `claims
   --check-anchors`, `faultWorkers` to `probe`.
2. **Refused, never ignored.** Malformed JSON, an unknown key, a wrong type
   or a `runnerCmd` without `{files}` and `{out}` is a usage error (exit 3)
   that names the key. `python` (when it contains a separator) and
   `nodeModules` are relative to the project directory and must stay inside
   the repository, judged by path text and never through symbolic links;
   anything else is the precondition `path-outside-project` (exit 2).
3. **No weaker than the flag.** A value from the file is held to the rules of
   its flag: a `confirm` below 3 is provisional, and the warning names the
   file.
4. **Which copy.** The working-tree copy is read, like the flags typed with
   the command. In worktree mode it is one of the files the dirty rule
   watches: an uncommitted or untracked copy refuses a probe of the implicit
   HEAD (`dirty-tree`), `--include-dirty` and `--in-place` measure the tree it
   belongs to, and `--ref` or `--ignore-dirty` proceed with a warning that the
   working-tree copy is applied. Because it is applied, it is not listed in
   `repo.ignoredDirty`, which names what was not probed. `replay`, which has no
   dirty rule, warns when it applies an uncommitted copy.
5. **Reuse compares resolved options, never the file.** The file is neither a
   dependency input nor part of `run.instrument`. A value moved from a flag
   into the file resolves to the same options and carries every verdict;
   a changed value refuses reuse exactly as the changed flag does.
6. **Reported.** `status --json` carries `config: {file, sha256, keys}`, every
   key the file sets; `probe --json` carries `run.config` with the keys this
   invocation took from the file and the ones a flag or variable overrode.

## Convergence

A scoped probe (`--claim`, or `--changed` with a determined selection) updates
the canonical evidence `.testguard/evidence.json` instead of leaving it to the
next full probe (#293). The written document holds, in claims-file order:

- **measured**: the records of the selected claims, as this run measured them
  (a record this run reused under rule 8, after its live baseline, counts as
  measured here: its claim was selected);
- **carried** (`carried: "inputs-match"`, with `reusedFrom`): for every other
  fault with a record in the canonical evidence, that record unchanged, when
  the probe finds in the tree it probed (HEAD, or the snapshot under
  `--include-dirty`) exactly the inputs the record was measured with. That
  check is the input half of rule 8's reuse rule (target, defenders, test
  universe, discovery, import closure, fault content, claim metadata), plus
  the same run-level rule (tool version and instrument digest, N, worker
  policy, runner, type-check command and program digest). Under `--typecheck`
  with equal digests no fault is checked again; evidence without a digest is
  checked fault by fault, and a fault is carried only if `detail.typecheck`
  agrees. What it leaves out is the live baseline: no defender runs for a
  carried record;
- **kept stale** (`carried: "inputs-changed"`, with `reusedFrom`): every other
  record, unchanged. It describes another tree. It is kept so that its verdict
  is not lost (`changedFaults` and `review-fault-change` depend on it), never
  as a statement about this tree. `status` names every such record stale by
  its mark, whatever its own hashing says: the probe's check sees inputs
  `status` does not (the test universe, discovery, the type check), and
  `status` and `baseline` must give the same answer about one document.

A kept-stale record is **never reuse and never current**. Its `reusedFrom` is
provenance only. Wherever it is reported, the output says why an unselected
record can have changed inputs when the selection was sound: its inputs changed
outside the change that was probed, either before that change's base (the
evidence is older than the base) or in an input the selection does not follow
(the test universe, defender discovery). Where the record is used:

- `status` lists it stale by name;
- per-claim results count it `unverifiable` with reason `inputs-changed`, so
  its claim reads `could-not-verify` unless a current fault makes it
  `unproven`;
- `baseline` refuses the document and names it;
- `--require-assertion-kill` is `unavailable` while one is present (state
  `unavailable`, `staleRecords`; exit 2), never `passed`;
- the origin policy is `unavailable` (`stale-inputs`).

A fault with no earlier record stays absent, so `status` still says it was
never probed. `run.reuse` is `{ measured, reused, stale }`: carried records
count as `reused`, kept-stale records as `stale` (absent when zero), and the
validator requires the three to add up to the record count.
`run.scope` names `selectedClaims`, `requestedClaims` for `--claim`, the
`changed` ref, base and head for `--changed`, and `carriedFrom`: the run whose
document the other records came from. A carried record keeps the verdict it
had, and convergence never upgrades one.

**What a carried record vouches for.** Its recorded inputs equal the tree this
run probed, under the same instrument. It does not vouch for anything no hash
sees (installed packages, the interpreter, a data file a test reads): that was
last checked by the run that measured it. **The full probe stays the periodic
re-verification**, and `status` notes how many records were carried.

**When the canonical file is not touched.** The run writes
`evidence-partial.json` as before, and says why, when any of these holds:

- it is provisional (`--confirm` below 3);
- its command budget ran out;
- it probes `--ref`;
- it runs with `--no-reuse`;
- `--out` names another file;
- there is no canonical evidence yet;
- the canonical evidence fails the run-level rule (any other TestGuard version
  or configuration digest carries nothing);
- another command wrote the canonical file while this one ran.

An undetermined `--changed` writes nothing at all. `--no-reuse` disables
carrying for the same reason it disables reuse: a gate over authors who can
write the evidence file must not trust a record it did not measure.

**Exit code and policies.** The findings gate and `run.claims[]` still read
only the measured records, so a scoped run's exit code keeps meaning "the
selection". The written document carries no origin or assertion policy from
the document it replaced. `--require-assertion-kill` gives two answers. The
document's `assertionPolicy` is evaluated over every record written: a carried
kill without a recorded `killKind` fails it, and a kept-stale record makes it
`unavailable`. The run's exit code, `probe --json`'s `run.assertionPolicy` and
the printed policy line judge only the records this run measured, as a scoped
run always has; the output says in one line when the document's answer
differs, naming what outside the selection it did not judge. So a stale record
from another commit never turns a scoped run red, and never reads as passed in
the evidence file either. `--require-origin` refuses `--claim` and
`--changed`, before this change and after it, so the origin policy has no
scoped answer to split.
`--require-origin` still refuses `--claim` and `--changed`, so a carried
record never contributes to an origin-policy pass.

**Baseline.** `baseline` keeps refusing a provisional or budget-cut document,
and also refuses a document holding any `inputs-changed` record, naming them.
When it freezes a document with carried records, it says how many.

Validators reject:

- a `carried` record without `reusedFrom`, or with this run's id;
- carried records in a document without `run.scope`;
- a carried record whose claim was selected;
- a record without `carried` whose claim was not selected;
- `run.scope` on a provisional or budget-cut run;
- `run.reuse` counts that do not add up to the records;
- an assertion policy whose `staleRecords` are not exactly the kept-stale
  records, or whose state is not `unavailable` while there is one.

Run ids name their start time to the millisecond (`run-20261112T153612123`;
earlier releases wrote seconds). A converging run checks that nobody else
wrote the canonical file by comparing ids, and it carries from an earlier run,
so two runs that start in the same second must not share one.

`probe --json` reports `run.converged`: `into` (the canonical file),
`carriedFrom`, `carried` and the `stale` fault ids, or `into: null` with the
`reason`.

## Per-claim results

`probe --json` carries `run.claims[]`: one entry per claim the invocation
measured, in the order probed, keyed by claim id (and, inside `reasons`, by
fault id, never by position or line):

```
{ id, result: "proven" | "unproven" | "could-not-verify",
  faults: { total, killed, survived, nocover, unverifiable, faultInvalid, timeout, flakyDefender },
  reasons: [{ faultId, verdict, reason? }] }
```

`faults` counts verdicts and `total` is their sum. `result` is derived from the
counts, in this order, rounding toward unproven:

1. any `survived` or `nocover` fault → `unproven`, whatever happened to the others;
2. otherwise at least one fault was measured and every one is `killed` → `proven`;
3. anything else (`unverifiable`, `timeout`, `fault-invalid`, `flaky-defender`, or
   no fault measured at all) → `could-not-verify`.

A record a converging probe kept stale (`carried: "inputs-changed"`, see
[Convergence](#convergence)) is counted as `unverifiable` with reason
`inputs-changed`, whatever verdict it carries.

`could-not-verify` is neither a pass nor a finding about the code: the
measurement did not happen, so the remedy is to repair the claim or the suite's
reliability, not to write a test for a fault nobody ran. `reasons` has exactly
one entry for each fault that was not killed. The block ignores the baseline
and the severity floor: it describes what this run measured, not what gates.
The validator re-derives every `result` from its counts and rejects a block
that disagrees, a `total` that is not the sum, a missing or duplicated reason,
and a block that does not name exactly the probed claims.

## External claims files

`--claims <path>` may name a file outside the project under probe, for `probe`,
`claims`, `admit` and `status`. Fault `file` and `defendedBy` stay
project-relative: they name files of the project, wherever the claims live.
`admit` takes the project to be the repository the test file lives in. A claims
file inside the project is not external; the project's own claims need no
mark. For an external file the evidence records `run.claimsSource: { external:
true, sha256 }` (the hash of the file's bytes), never its path, and `status`
reports `claimsSource` in place of `paths.claims`. Nothing is written beside the
external file: evidence, partial evidence and baselines stay under the project's
`.testguard/`.

Every evidence record embeds the claim's id, statement, severity and source, so
a consumer without the claims file can still read the results per claim id. It
cannot check `claim-changed` (claim metadata against the file) and cannot tell
whether the file it was measured against is the one a caller holds, except by
comparing `sha256`.

### The worker index

Every test runner process a probe starts gets `TESTGUARD_WORKER` in its
environment: the 0-based index of the scratch tree it runs in. Trees that run
side by side have different indices; a run with nothing else in flight (one
fault at a time, a confirmation, a re-measure, the serial lane) is worker 0.
A suite that needs a port, a database or a directory of its own derives it
from the index (`8787 + TESTGUARD_WORKER`) and stays parallel instead of being
measured alone. The index is never part of a verdict or of reuse.

Two probe commands on one machine (two agent sessions) must not hand out the
same index (#293). Each command adds a base: `TESTGUARD_WORKER_BASE` when set
(a non-negative integer, else a usage error), otherwise its slot times 100.
The slot is the lowest one no live command holds, recorded as a pid-owned lock
file under the scratch root's `testguard-locks/worker-slots/`, beside the
worktree lock, and removed when the command ends. A slot whose owner is
provably gone (same host, pid not running) is taken over. A lone command holds
slot 0 and hands out 0, 1, 2… as before. Commands that use different scratch
roots do not coordinate; with every slot held, or a scratch root that cannot
hold a lock file, a command starts at 0.

## Speed advice

`status`, `brief` and the end of a text-mode `probe` carry `advice` (#270):
where a run is leaving speed on the table, one line each with the exact
command. Advice is informational. It never changes `state`, `next`, a verdict
or an exit code; computing it reads only files on disk, the machine's CPU count
and local git, and makes no network call. The set is closed:

| id | when | command |
|---|---|---|
| `serial-on-multicore` | the last evidence ran one fault at a time (no `run.faultWorkers`) because it was asked for (`faultWorkersSource` `serial`, `flag`, `env` or `config`, or absent: evidence from before 0.24), and the automatic width on this machine is above one | `testguard probe` (`testguard probe --fault-workers auto` when the width came from `testguard.config.json`, which would otherwise ask for one again) |
| `full-probe-where-changed-would-do` | asked about a change — `status --changed <ref>`, or the end of a full probe with the base `--changed auto` would use — `next.action` is `probe` (status), and the change selects fewer claims than the file holds (the selection rule of [Probing a change](#probing-a-change)). Selecting walks every claim's import closure, so a `brief`, the MCP tools and a `status` without `--changed` do not compute it. | `testguard probe --changed auto` |
| `nothing-reused` | the last evidence reused no verdict, measured at least one fault, and took a minute or longer | `testguard probe` |
| `slow-defenders-dominate` | the last evidence holds at least 20 claims and 600 s of recorded defender time, and one to three claims each hold at least 10% of it with at least 5 runs at a median of at least 15 s per run, together at least 25%. The message names each claim, its summed seconds, its slowest defender file with the median seconds per run of every run that included it and that run count (runs execute a claim's defenders together, so a file's time is a ceiling, as in `--cost`), and says to give the claim a faster defender or split the file. Read from recorded `durationMs`; nothing is run. The thresholds are measured: this repository's own evidence peaks at 6.2% and a median 9.9 s, so the rule is silent there; the field run that prompted it had claims at 34% (73 s) and 18% (32 s) | `testguard claims --cost` |
| `hook-outdated` | a hook or CI file in the repository runs TestGuard with `probe --serial`, probes every claim from a pre-push hook, pins `testguard-cli@<x.y.z>` or the action or pre-commit `rev` below this version, runs a floating version (`testguard-cli@latest`, `@next` or `@*`, or `npx testguard-cli` with no version; managed blocks included), or holds a TestGuard managed block from an older template; one line per file and line, at most five | `testguard init --upgrade` |

A selection's view (`--claim`, `--changed`) carries no advice. Validators
reject an unknown id, a command that is not a `testguard` command, an id other
than `hook-outdated` said twice, `slow-defenders-dominate` with any command but `testguard claims --cost`, `full-probe-where-changed-would-do` where
`next.action` is not `probe` or whose command is not a `probe --changed`, and
`hook-outdated` with any command but `testguard init --upgrade`, in a status
document and in a brief alike.

**Managed blocks.** What `init` writes for the fast path — the pre-push block
(in `.husky/pre-push` when the repository uses husky, else
`.githooks/pre-push`; never `.git/hooks`), the `--ci github|gitlab` file, the
skill and the `AGENTS.md` section — carries `template=<n>` and, for blocks and
the skill, the sha256 of its body. `init --upgrade` rewrites one only when it is
from an older template and its body still has its recorded hash (or, for a
skill written before markers, equals a template a release shipped); an edited
one is reported and left alone unless `--force`. Nothing outside a block is
touched.

**Pinned versions (#293).** The pre-push block runs an installed TestGuard
only (the project's, the repository root's, then one on PATH); with none it
prints how to install exactly the version that wrote it and lets the push
through, fetching nothing (#301: an npx fetch fails where npm refuses fresh
releases, and would run unreviewed code from a hook). The CI files run the
project's installed TestGuard, else exactly the version that wrote them (`npx
-y testguard-cli@<x.y.z>`). Neither ever runs a floating tag: a floating tag would run every
new release in an adopter's CI before anyone reviewed it. GitHub Actions in
the CI template are pinned by commit SHA with the version in a comment. With a
`package.json`, `init` adds `testguard-cli` at that exact version to
`devDependencies` (an existing spec is left alone: a floating one is reported,
a range is noted), and writes a dependency-update rule so releases arrive as
pull requests: a Renovate `packageRules` entry when the repository has a JSON
Renovate config, otherwise a Dependabot `npm` entry limited to
`testguard-cli`, never a second `npm` entry for a directory that already has
one (the lines to add are reported instead). Template 3 is the first with these
pins, so `init --upgrade` rewrites an unedited block from template 2.

**The pre-push block under version skew (#293 review).** The block asks the
resolved binary for `--version` before passing it anything, and passes its
probe command only when that version is at least `HOOK_MIN_VERSION` (the
release that added the newest flag the block uses, `--when-no-base`; bumped
only when the block starts using a newer flag). An older or unreadable
version prints one line naming both versions and how to install, and lets the
push through unprobed. Of the probe's exit codes, only 1 (unproven) and 2
(could not evaluate) refuse the push; 3 (a usage error: an edited flag, or a
binary the version check could not catch) prints one line and lets it
through. `TESTGUARD_SKIP_HOOK=1` skips the block with a one-line notice. The
CI templates pass only `probe --changed auto` and `probe`, which every release
since 0.24.0 accepts, so an installed binary older than the template that
wrote them needs no guard there; one older than 0.24.0 fails the CI job with
exit 3, visibly, and the exact-pinned devDependency `init` adds keeps the
installed version at the one that wrote the template.

## Thin claims

`claims` and `status` flag a claim with fewer than two faults (`fewer-than-two-faults`),
or whose faults all share one `faultClass` (`single-fault-class`), as
`claim-thin`. It is advisory: it never changes a state, an exit code or a
verdict. A claim whose every fault is killed is proven against one way of being
wrong, or one kind of wrong; the signal says how much that proves. `status`
lists them in `thinClaims` (absent when none); `claims --json` always carries
`thinClaims`.

## Severity floor

`--severity <level>` gates only findings whose claim severity is at or above
the level. Findings below the floor are still reported and still written to
evidence; they simply do not turn CI red.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No new gating findings at or above the severity floor. |
| `1` | At least one new gating finding. |
| `2` | Precondition failed (or, with `probe --partial-on-budget`, the command budget ran out and the measured part holds nothing that gates: `run.failureKind` `incomplete`; or, for `probe --changed`, the change could not be measured, or selected nothing under `--fail-on-empty-selection`): test runner not resolvable (e.g. no `node_modules` linked into the scratch worktree), working tree dirty for a fault target file, claims file invalid, no commits. Nothing was probed. |
| `3` | Usage or configuration error. |

A command interrupted by a signal exits `128` plus the signal number (SIGINT
`130`, SIGTERM `143`, SIGHUP `129`) after stopping its runners and removing its
scratch trees, and publishes nothing.

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

### Refusals under `--json`

A refusal is one JSON value on stdout whatever stopped the run. Under `--json`,
every exit `2` and every exit `3` writes an `error` document
(`error.schema.json`: `{schemaVersion, tool, error: {kind, message, exitCode}}`)
and keeps the human message on stderr; a refusal that produced no document
before it, whether thrown or reported by a command that returned the code, is
never an empty stdout. `exitCode` is `3` exactly when `kind` is `usage`.
A command that already writes a document for the refusal is not given a second
one: an undetermined `probe --changed` writes the status document with
`run.exitCode: 2` and `run.scope.changed.outcome: "undetermined"`. A reader
checks for `error` first; when it is present nothing was measured.

`usage` (exit 3) is a request that is wrong whatever the repository holds: a bad
value, an unknown option, flags that cannot be combined (`--include-dirty` with
`--in-place`, `--ref` with `--in-place`, `--fault-workers` above 1 with
`--in-place`). A condition that depends on the tree is a precondition (exit 2).
Exit-2 kinds are `claims-file`, `git`, `spec-document`, `refused` (a command
declined and said why on stderr), `internal` (a defect in testguard) and the
precondition kinds named in `PRECONDITION_KINDS`
(`src/probe/precondition-error.mjs`): every `PreconditionError` carries one, and
the build refuses a throw site without it.

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
resolved defenders, current discovery dependencies and the recorded runner
identities (name, version and source). Missing bindings or
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
Mixed-runner partitions remain sequential, and faults are probed one at a
time unless `--fault-workers` fans them out (see [Fault fan-out](#fault-fan-out)). This is a worker ceiling,
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
partitions. Reused records and cached baselines create no invocation charge;
the one live baseline run that licenses reuse of a defender set (rule 8) is a
real invocation, charged once and also counted in optional
`reuseBaselineRuns`.
`elapsedMs = runnerMs + overheadMs`. `runnerMs` is wall-clock time during
which at least one fresh runner invocation was executing: the sum of the
invocations when faults run one at a time, the union of their intervals under
a fault fan-out, so overlap is charged once and `overheadMs` is never negative. Optional `run.workers` records the built-in
worker ceiling and must be one for serial execution; custom commands omit it.
Native evidence reuse requires the same recorded worker ceiling and serial policy,
and a compatible fault fan-out (see [Fault fan-out](#fault-fan-out)).
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

## Fault fan-out

`probe --fault-workers <n|auto>` probes up to n faults at once. Each
fault in flight has its own scratch worktree at the probed commit; no two
faults ever share a tree, so an explicit n above one is refused with
`--in-place` (a usage error, exit 3, at the CLI; a precondition error through
the API). n = 1 is the serial run exactly: the same invocations in the same
order, and evidence without `run.faultWorkers`.

**The width (#270).** The CLI resolves n in this order: `--serial` (the flag
as typed, never the derived one-runner-worker default) means one fault at a
time and is refused beside `--fault-workers` above one; then
`--fault-workers <n|auto>`; then `TESTGUARD_FAULT_WORKERS` (empty is unset);
then `faultWorkers` in `testguard.config.json` (see [Project
configuration](#project-configuration)); then `auto`. `auto` is `min(4, floor(cpus / 2))`, at least one, where cpus is
`os.availableParallelism()`; `--in-place` resolves it to one. When other test
runners are already running as the probe starts (the contention check), an
automatic n is halved (at least one) and the probe says so; a chosen n is
kept. The evidence records `run.faultWorkersSource` (`auto`, `flag`, `env`,
`config`, `serial`, `in-place`) and, for `auto` only, `run.cpus`. The library API
defaults to one and records no source unless its caller passes one.

1. **Plan, then measure.** Every fault is first planned in claim/fault order
   on the first scratch tree with no fault applied anywhere: defender
   resolution and discovery, every input hash, the anchor, reuse eligibility
   and the `--typecheck` check (so its incremental build-info lives in one
   tree only). None of this depends on a baseline.
2. **Baselines.** Each defender set's baseline asks (one live run that
   licenses reuse, then N runs unless reuse held) are replayed in the order a
   serial run makes them, so `runnerInvocations` and `reuseBaselineRuns`
   match. Different defender sets are independent and are measured side by
   side, at most n at once, one set per scratch tree. A set measured while
   another was in flight whose runs are anything but green N/N is not
   believed: it is measured again with nothing else in flight, in a fresh
   scratch tree, and the records that use it report those runs with
   `detail.baselineRemeasuredSerially: true`. Baselines are then frozen. The
   rest of planning (the reuse decision, the baseline a record reports) runs
   in claim/fault order against them, and a fault that never mutates (reused,
   no defenders, a bad anchor, a refused type check, a baseline that is not
   green N/N) is finished there. A fault measured in another tree reads the
   baselines, it never runs them.
3. **Fan-out.** The remaining faults are handed, in order, to at most n trees.
   The baseline phase's trees serve as fault trees (#293): a baseline never
   applies a fault, so its tree is kept, and reused only while `git status`
   (tracked and untracked files) reads exactly as it did right after the tree
   was created. A tree that reads otherwise is removed and replaced by a fresh
   one, and kept trees the fault phase does not need are removed then.
   A fault's probe runs, its negative control and its escalation all run in
   the tree that holds it. A negative control shared by two faults (same
   target, same defenders) is paid once, by whichever asks first.
4. **Order.** Records and the per-record progress stream (`onProgress`,
   `--progress ndjson` verdicts) follow claim/fault order whatever order the
   trees finish in. Apart from timings (`durationMs`, `run.measurements`),
   `run.faultWorkers`, `run.faultWorkersSource`, `run.cpus`,
   `probeRuns[].alone`, `detail.remeasuredSerially`,
   `detail.baselineRemeasuredSerially` and `detail.notParallelSafe`, the
   evidence has the content a serial run of the same commit would have.
   Per-stage progress lines from different trees interleave.
5. **Contention is not a verdict.** Per-run budgets (`--budget`) do not scale
   with the fan-out. A record measured while another fault was in flight whose
   verdict is `timeout`, `flaky-defender` with reason `inconsistent-probe`,
   `fault-invalid` (any reason but `replacement-does-not-typecheck`, which is
   decided while planning), `unverifiable`, or `survived` with reason
   `killed-by-undeclared-tests` (the wider suite's run is the one most exposed
   to neighbours, and its attribution names killers), or with any probe run
   whose outcome is `error` (a suite that would not load: a neighbour can hold
   the port its dev server needs, #287), is not reported from that
   measurement: after the fan-out it is measured
   again with nothing else in flight, in a fresh scratch tree (the contended
   run may have left state in its own), reusing its frozen baseline, and the
   serial measurement is what the record reports, whatever its verdict, with
   `detail.remeasuredSerially: true`. Records after it in order wait for it.
   `defenders-not-green` is never re-measured as a fault: a contended
   baseline was already re-measured alone (rule 2). Validators reject
   `remeasuredSerially` and `baselineRemeasuredSerially` on a document without
   `run.faultWorkers` above one, and `run.faultWorkers` together with
   `mode: "in-place"`.
6. **Reuse.** `run.faultWorkers` is recorded only above one. Every fan-out of
   one tool version is guarded alike (rule 11), so its width is not part of
   what was measured: a measurement under a fan-out stands in for a fan-out of
   any width, and for a run whose one fault at a time was not asked for (an
   automatic width of one). It never stands in for a run that asked for one
   fault at a time (`--serial`, or one by `--fault-workers`,
   `TESTGUARD_FAULT_WORKERS` or `faultWorkers` in `testguard.config.json`). A serial measurement (no `run.faultWorkers`)
   may stand in for any. A reused record keeps the marks of the run that
   measured it (`alone`, `remeasuredSerially`, `notParallelSafe`), whatever
   the current run's width; validators judge those marks only on records this
   run measured. A run probing a selection (`--claim`, `--changed`) reads the
   canonical evidence as a reuse source beside its own output file; each
   document must pass the reuse rules on its own, and where both hold a fault
   the one that finished later is used.
7. **Contention advice.** The contention warning names `--fault-workers` when
   the probe fans out, and the probe warns before the first run when n times
   the runner's worker count exceeds the CPUs available to the process.
8. **Lifecycle.** `--command-budget` is one deadline for every tree and is
   checked before each fault is dispatched. On a failure no further fault is
   dispatched, every fault in flight finishes and restores, every tree is
   removed, and the failure of the lowest fault index is raised (the one a
   serial run would have met first). Cancellation stops every tree's runners
   and removes every tree. Interrupted runs leave no scratch worktree.
9. **Shared worktree registry.** Scratch-worktree allocation and removal (add,
   remove, prune) hold one lock file, `testguard-worktrees.lock`, keyed by the
   git common directory and kept under TestGuard's scratch root (never inside
   the repository), so two probes of one repository, or of its linked
   worktrees, sharing a scratch root cannot allocate or prune each other's trees. The lock is held
   only around those synchronous git calls. A lock whose owner pid is no longer
   running on the same host is stale and is taken over; a live owner is waited
   on for at most two minutes, after which the command fails rather than
   proceed unlocked. Every git call that creates, removes or prunes a scratch
   tree runs with inherited `GIT_*` variables removed, `GIT_TERMINAL_PROMPT=0`,
   `core.hooksPath` set to the null device and `core.fsmonitor=false`.
10. **Isolation is per tree, not per machine.** Python, `--runner-cmd` and every
   built-in runner are supported; each tree has its own files and its own
   working directory. `node_modules` is linked into every tree as for one, so
   the disk cost is one checkout per tree. Tests that bind a fixed port, share
   an external database or write outside the project tree can collide across
   trees; rule 11 is what keeps such a collision from becoming a verdict.
11. **Every kill rests on a run alone (#270).** A fan-out is on by default, so
   it may not depend on the suite being hermetic. A suite that shares a fixed
   port, a database or a temp path across trees can fail N/N beside another
   fault although the fault changes nothing it asserts: a kill that did not
   happen. So:
   - Every probe run measured in a fan-out records `alone: true` exactly when
     no other fault's measurement (apply to restore) was in flight at any
     moment between its start and its end.
   - Before its last probe run, a fault whose runs so far were all kills,
     none alone, while another fault is in flight, stops and restores. After
     the fan-out, in claim/fault order, in one fresh scratch tree with nothing
     else in flight, the fault is applied again and its last run is taken
     alone (counted in `run.measurements.aloneConfirmRuns`, timed in
     `aloneConfirmMs`). A fault whose N kills turned out to have no run alone
     after all (another fault began during the last) sets the last run aside
     and is confirmed the same way. `probeRuns` stays N runs long, so the
     guard costs a hermetic suite no extra run, only the confirmations' lost
     concurrency.
   - A run alone that passes while a run beside other faults did not is a
     **disagreement**: the red was the neighbours'. It never reaches the
     verdict function as `inconsistent-probe`. The fault is measured again,
     alone and in full (rule 5's re-measure), and its defender set is **not
     parallel-safe** for the rest of the run. So is a set whose baseline was
     red beside other sets and green alone (rule 2). The probe warns once per
     such set, naming its files.
   - Every fault of a set already not parallel-safe when the fan-out starts
     is probed after it, alone, in one scratch tree, as a serial run would.
     Every kill in a set that became not parallel-safe and does not rest
     only on runs alone is measured again, alone and in full. Each record
     of such a set says `detail.notParallelSafe: true`.
   - Nothing above is published, or survives a command budget that runs
     out, before it is decided: a deferred kill or a disagreement held when
     `--partial-on-budget` stops the run is reported `not-reached`.
   - A negative control or survivor measured beside other faults can only
     lean towards red, which keeps a survivor a survivor: the pessimistic
     side, so neither is re-measured.
   - A claim that declares `serial: true` (claims schema) is probed like a set
     already not parallel-safe: after the fan-out, alone, every run `alone`,
     and its records say `detail.serialDeclared: true`. A declaration, not a
     detection: both may apply to one record.
   **What a fan-out kill rests on.** N red runs, at least one alone. In a set
   that never showed interference the other runs count as a serial run's
   would. If the set does interfere, the run alone disagrees and the set is
   held to N runs alone — unless every contended run was failed by a
   neighbour *and* the run alone failed by the defenders' own flakiness on a
   fault they do not detect, a coincidence that a baseline green N runs out
   of N bounds. A validator rejects a fan-out document in which a measured
   `killed` record has no probe run alone, or in which a record with
   `remeasuredSerially`, or a `killed` record with `notParallelSafe`, has a
   run that was not alone; `alone`, `notParallelSafe` and the guard's
   measurements are rejected on records and runs of a document without a
   fan-out, unless the record is reused.
