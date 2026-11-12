# Provenance: js-vitest-booking

Room booking slots, conflicts, pricing and summaries (vitest; `src/format` is a symbolic link to `lib/format`).

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `a20174c4e1e181d1…` (+ turn 2 `15401807067554c5…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `a5ab68ec9202f3fa…` (+ turn 2 `7bc3e2853d896bad…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `d4f5638766186523…` (+ turn 2 `b2be1aa9db4904c9…`) | 18 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `eb13b109c1485217…` (+ turn 2 `f66422a325bc2f12…`) | 21 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned vitest 5.0.5), package-lock.json, the src/format symlink, subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. test/slots.test.js: THOROUGH for R1-R3 (every error class and the order of checks).
2. test/conflicts.test.js: THOROUGH for R4-R6.
3. test/pricing.test.js: PARTIAL ON PURPOSE. Test R7-R9 for MEMBERS ONLY (peak/off-peak split, rounding, the 4-hour discount boundary). Do NOT price any drop-in booking and do not test UnknownCustomerError.
4. test/format.test.js: THOROUGH for R10-R11, importing from the real directory: `from '../lib/format/index.js'`.
5. test/summary.test.js: THOROUGH for R12, importing `from '../src/summary.js'` (which reaches the formatting helpers through the src/format link).
6. test/legacy-rates.test.js: imports `{ legacyRate } from '../src/legacy-rates.js'` — a module that does NOT exist (it was removed) — and has one test asserting legacyRate('member') equals 1800. This file is expected to fail to load; write it anyway, exactly as described.

## Fault quotas given to the claim author

- Write 6 to 7 claims with 13 to 17 faults in total, covering R2, R3, R4, R6, R7, R8, R11 and R12 at least.
- One claim tied to R11 (money formatting) has its faults in `lib/format/money.js` (the real path).
- One claim tied to R12 (slot summary) has at least one fault whose "file" is written THROUGH THE LINK as `src/format/duration.js` (the same file as lib/format/duration.js).
- One claim tied to R8 (minute pricing) with 2 faults in src/pricing.js.
- In the pricing area include one fault that changes the price ONLY for drop-in visitors.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- test/legacy-rates.test.js imports a module that does not exist, on purpose: it is the only declared defender of the minute-pricing claim, which is keyed unverifiable/defenders-failed-to-load.
- The test author's first reply had one test that failed on the source (`formatMoney(-0)` returns `"$-0.00"`); it was sent back on the same channel with the failing output only (prompts/tests-turn2.md) and fixed there, never edited by the orchestrator.
