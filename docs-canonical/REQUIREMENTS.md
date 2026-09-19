# Requirements

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-19 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality passive-voice off — requirements are written in the standard "the system shall ..." register, where the agent is the system throughout. -->

> Canonical. Code that contradicts this document is drift.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Accept a claims file declaring statements, provenance, defenders and deterministic faults, and reject any file that does not conform | P1 |
| FR-02 | Apply each fault in isolation from the user's working tree, run the claim's defenders, and restore — unconditionally in-place, and in a scratch worktree except where the target itself no longer exists, which is recorded rather than raised | P1 |
| FR-03 | Emit a verdict from a closed set of seven, where only `killed` is a pass | P1 |
| FR-04 | Confirm `killed` and `survived` over N runs (default 3), on a baseline that was green N/N | P1 |
| FR-05 | Never count a timeout, a load failure or a mixed result as detection | P1 |
| FR-06 | Freeze a baseline of existing debt and gate only the delta | P1 |
| FR-07 | Report where the suite is blind to an agent before it writes code (`brief`, `status`, MCP) | P1 |
| FR-08 | Fail when a changed source file carries no claim and no excusing ignore entry (`gate --changed`) | P1 |
| FR-09 | Exclude tests that mock the subject from defender discovery, and report them | P1 |
| FR-10 | Support vitest and jest as project runners, and Playwright per file | P2 |
| FR-11 | Propose faults mechanically for a source file, as a draft a human keeps or drops (`scaffold`) | P2 |
| FR-12 | Answer whether one test satisfies the two-gate rule for a claim (`admit`) | P2 |
| FR-13 | Replay historical fix commits to measure whether the suite would have caught them, and calibrate by fault class | P3 |
| FR-14 | Serve the read-only operating loop over MCP so the loop survives a change of agent harness | P3 |
| FR-15 | Validate every exact fault anchor and the syntax of supported in-memory replacements before starting a test runner (`claims --check-anchors`), without guessing repairs | P1 |

## Non-Functional Requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-01 | No network access at run time, no telemetry | the CLI opens no socket; the session-start hook contains no form of `npx` |
| NFR-02 | Exactly one runtime dependency, exact-pinned | `ajv` 8.20.0; proven by the install smoke gate |
| NFR-03 | The user's working tree is never damaged | scratch worktree by default; restore on signal, exception and exit; refusal to run in place over a dirty target; a restore failure is raised in every case but a scratch target that has already been deleted |
| NFR-04 | Every emitted document conforms to the published schema before it is written | `writeSpecDoc` refuses non-conforming output |
| NFR-05 | Verdicts are reproducible and attributable to a commit | evidence records `repo.head`, the snapshot when the working tree was probed, and the runner and its source |
| NFR-06 | A verdict is never optimistic under uncertainty | contention recorded and re-checked for liveness before it is reported; flaky and timeout verdicts gate; escalation cannot upgrade a verdict; a survivor is unverifiable until the defenders are shown to fail because of the subject; an unexpected exception is named as the tool's own defect rather than shown as a bare stack |
| NFR-07 | Cost grows with what changed, not with the size of the project | verdict reuse on unchanged inputs; blast-radius-targeted escalation; a committed cost budget gated in CI on two ceilings — the total, and a per-claim ceiling the total cannot see — reported to the job summary, so growth is signed for rather than discovered |
| NFR-08 | Portable contract | schemas are JSON Schema 2020-12, readable and implementable without this codebase |

## Success Criteria

| Criterion | Target | Status at v0.6.0 |
|---|---|---|
| Reproduces a known-answer oracle for every verdict, per runner | 3 runners | met — vitest, jest, Playwright fixtures |
| Self-verification gates the release | every fault killed | met — 62 faults, all killed |
| Finds real blind spots in real code | field evidence, not synthetic | met — two independent field reports on AI-authored codebases; 8 of 9 historical bugs invisible to a 4,900-test suite; 21 of 39 faults survived a green suite on a second codebase |
| Every field-report defect closed | 11 of 11 | met at v0.6.0 |
| Documentation cannot drift from code unnoticed | enforced, not reviewed | this document set, plus DocGuard hooks in CI and pre-commit |

## User Scenarios

### User Story 1 — The agent that tested its own bug (Priority: P1)

An agent writes a feature and its tests. Both encode the same misunderstanding.
The suite is green, coverage is high, and the defect ships. **With TestGuard**,
the claim the feature is supposed to satisfy carries a fault; the probe shows
the fault surviving; the agent is told, before it writes more code, that the
claim is unproven and which test must change.

### User Story 2 — The suite that mocks what it claims to defend (Priority: P1)

Eighteen tests import a permissions module; sixteen mock it. Coverage says the
module is well tested. **With TestGuard**, discovery excludes the sixteen, the
claim reports `NOCOVER`, and `claims` prints `18 import · 16 mock · 2 can
detect`.

### User Story 3 — The invisible control (Priority: P2)

A toggle stops rendering. Every unit test passes because none looks at the
markup. **With TestGuard**, the claim names a browser-layer spec as a second
defender; the `element-removed` fault survives the unit test and is killed by
the spec, and the evidence records which file ran under which runner.

### User Story 4 — The feature nobody claimed (Priority: P1)

A new module ships with green tests and no claims at all. Probe says nothing,
because it verifies only claims that exist. **With TestGuard**, `gate --changed`
fails the pull request naming the unclaimed file, and `status` reports
`unclaimed-changes` with writing the claim as the single next action.

## Traceability Matrix

| Requirement | Implementation | Verified by |
|---|---|---|
| FR-01 | `src/claims/load.mjs`, `spec/schemas/claims.schema.json` | `spec/conformance/`, `TG-WRITER-REFUSES` |
| FR-02 | `src/probe/worktree.mjs`, `src/probe/inject.mjs` | `test/worktree.test.mjs`, `test/inject.test.mjs`, `TG-RESTORE-ALWAYS`, `TG-RESTORE-SURVIVES-A-VANISHED-TARGET`, `TG-IN-PLACE-STILL-RAISES-A-MISSING-TARGET`, `TG-SYMLINK-NODE-MODULES` |
| FR-03 | `src/probe/classify.mjs` | `test/classify.test.mjs`, `test/negative-control.test.mjs`, the known-answer fixtures |
| FR-04 | `src/probe/probe.mjs` | `TG-KILL-NEEDS-N` |
| FR-05 | `src/probe/classify.mjs` | `TG-TIMEOUT-NEVER-KILLS`, `TG-PW-TIMEOUT-NEVER-KILLS` |
| FR-06 | `src/baseline/baseline.mjs` | `test/baseline.test.mjs`, `TG-RESTAMP-REQUIRES-SAME-FINGERPRINTS` |
| FR-07 | `src/brief/`, `src/status/`, `src/mcp/` | `test/brief.test.mjs`, `test/status.test.mjs`, `TG-MCP-IS-READ-ONLY` |
| FR-08 | `src/gate/changed.mjs` | `test/gate.test.mjs`, `TG-GATE-UNCLAIMED-EXITS-1` |
| FR-09 | `src/probe/mocks.mjs` | `test/mocks.test.mjs`, `TG-MOCKING-FILE-IS-NOT-A-DEFENDER` |
| FR-10 | `src/probe/runners/` | fixture acceptance per runner, `TG-RUNNER-FROM-PROJECT-FIRST` |
| FR-11 | `src/scaffold/producers.mjs` | `test/scaffold.test.mjs`, `test/scaffold.python.test.mjs`, `TG-SCAFFOLD-ANCHORS-HIT`, `TG-SCAFFOLD-NEVER-PROPOSES-A-NO-OP`, `TG-SCAFFOLD-LOOP-GUARD-IS-A-GUARD` |
| FR-12 | `src/admit/admit.mjs` | `test/admit.test.mjs`, `TG-ADMIT-NEEDS-ALL-KILLED` |
| FR-13 | `src/replay/` | `test/replay.test.mjs`, `test/calibration.test.mjs`, `TG-REPLAY-FLAKY-IS-NEVER-CAUGHT`, `TG-CALIBRATION-COUNTS-NOCOVER-AS-A-MISS`, `TG-CALIBRATION-COUNTS-ONLY-BUGS` |
| FR-14 | `src/mcp/` | `test/mcp.test.mjs` |
| FR-15 | `src/claims/anchors.mjs`, `src/commands/claims.mjs`, `src/status/status.mjs` | `test/claims-anchors.test.mjs`, `test/status.test.mjs`, `TG-ANCHOR-PREFLIGHT-FAILS-FAST` |
| NFR-01 | `src/init/init.mjs`, runner resolution | `TG-INIT-HOOK-NO-NETWORK`, `TG-README-HOOK-MATCHES-THE-CODE` (every surface, not only the README), `TG-GITIGNORE-ADVICE-IS-ONE-LIST` |
| NFR-02 | `package.json` | `npm run test:install` in CI |
| NFR-03 | `src/probe/inject.mjs`, `src/probe/probe.mjs` | `TG-DIRTY-DEFENDERS-REFUSED`, `TG-IGNORED-DIRTY-RECORDED`, `TG-IN-PLACE-STILL-RAISES-A-MISSING-TARGET`, `TG-CONTROL-RESTORES-THE-SUBJECT` |
| NFR-04 | `src/evidence/writer.mjs` | `test/writer.test.mjs` |
| NFR-05 | `src/probe/probe.mjs` | `TG-FINGERPRINT-VERDICT`, `TG-FAULT-EDIT-VISIBLE` |
| NFR-06 | `src/probe/contention.mjs`, `classify.mjs` | `TG-CONTENTION-NEVER-FAILS-A-PROBE`, `TG-ESCALATION-N-RUNS`, `TG-ONE-BAD-FAULT-KEEPS-THE-EVIDENCE`, `TG-A-PRECONDITION-STILL-REFUSES-THE-RUN`, `TG-A-PROBE-ERROR-IS-NEVER-REUSED`, `TG-SURVIVOR-PROVES-THE-SUBJECT-RUNS`, `TG-CONTROL-READS-ANY-RED-AS-REACHED`, `TG-FATAL-EDIT-CANNOT-COMPILE`, `TG-CONTENTION-IGNORES-A-DEAD-PID`, `TG-CLI-NAMES-ITS-OWN-BUGS` |
| NFR-07 | verdict reuse, `src/probe/rank.mjs`, `src/probe/cost.mjs` | `test/probe.fixture.test.mjs` reuse case, `test/cost.test.mjs`, `TG-COST-BUDGET-ACTUALLY-GATES`, `TG-PER-CLAIM-BUDGET-ACTUALLY-GATES` |
| NFR-08 | `spec/` | `spec/conformance/schemas.test.mjs`, `TG-WILSON-REPRODUCES-AT-THE-DOCUMENTS-PRECISION` |

## Revision History

| Version | Date | Change | Author |
|---|---|---|---|
| 1.0.0 | 2026-09-18 | First canonical requirements, written against v0.6.0 | @raccioly |
