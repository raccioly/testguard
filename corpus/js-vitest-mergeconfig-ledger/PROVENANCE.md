# Provenance: js-vitest-mergeconfig-ledger

Shared-expense splits, balances and settlement (vitest config built with `mergeConfig` imported from `vite`, #278); the harness gives each copy a node_modules whose entries are symlinks into this subject's install, as a worktree linked to another checkout's install has them (#279).

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `deafd3cca20ccea3…` (+ turn 2 `4f5fbd2b497a2e24…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `d9c7527106fdb767…` (+ turn 2 `380797ecc71ed47b…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `6244361632b9f1c1…` (+ turn 2 `c300b4c0a4a15563…`) | 16 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `6f37d47800fcee27…` (+ turn 2 `1f3aca881719cc74…`) | 22 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned vite 8.3.8, vitest 5.0.5), package-lock.json, vite.config.js, vitest.config.js, subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. test/split.test.js: THOROUGH for R1-R4 (equal and shares examples, remainder order, every InvalidAmount/InvalidSplit/UnknownSplitType case).
2. test/balances.test.js: THOROUGH for R5-R6 (payer as participant, sum to zero, order independence, empty ledger).
3. test/settle.test.js: PARTIAL ON PURPOSE. Only the empty-ledger case and one two-person case (one payment). Do not test three or more people or tie-breaking.

## Fault quotas given to the claim author

- Write 5 claims with 10 to 12 faults in total: at least one claim each tied to R2, R3, R4, R5 and R8.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The test author's first reply produced a negative zero in a helper; it was sent back on the same channel with the failing output only (prompts/tests-turn2.md) and fixed there.
