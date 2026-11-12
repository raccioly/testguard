# Provenance: js-vitest-projects-habits

Habit streaks and weekly completion (vitest with `test.projects`: two projects, one test file in each, one file in both; #277).

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `7d752567c00e75d3…` (+ turn 2 `b3ad84b6ceeb9816…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `be6914b50cb41857…` (+ turn 2 `5bdcdcba0fb307f0…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `15855791f6e93264…` (+ turn 2 `ffbc56058739f7f2…`) | 30 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `86d721e0d950f21f…` (+ turn 2 `6f376e77356a719a…`) | 35 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned vitest 5.0.5), package-lock.json, vitest.config.js (the two projects), subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. test/shared.test.js (runs in BOTH projects): THOROUGH for R1-R3. PARTIAL ON PURPOSE for R4: test that a freeze day is accepted, but never test ConflictError.
2. test/streaks/streak.test.js: THOROUGH for R5-R7, including the spec's freeze examples.
3. test/weekly/weekly.test.js: THOROUGH for R8-R9 (every example value, the week containing a Wednesday, future days in the week).

## Fault quotas given to the claim author

- Write 5 claims with 10 to 12 faults in total: at least one claim each tied to R2, R5, R6, R8 and R4.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The test author's first reply had one test that failed on the source (a wrong expected streak); it was sent back on the same channel with the failing output only (prompts/tests-turn2.md) and fixed there, never edited by the orchestrator.
