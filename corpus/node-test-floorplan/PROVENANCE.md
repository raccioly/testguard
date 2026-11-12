# Provenance: node-test-floorplan

Floor planner (two-package npm workspace, node:test).

Every author was a separate subagent (model `claude-sonnet-5-5`, chosen as the cheaper model that does the job; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written: the blindness is physical, not on trust. Every file read by an author was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec author | a one-paragraph domain brief and the format rules | SPEC.md | `0a5a1c63bb4052bf…` | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | packages/*/src/*.js, the three package.json files | `d3027fd2811319de…` | 0 |
| Claim author | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault-kind quotas | provenance/claims.author.json | `6d08b0d072341466…` | 20 |
| Test author | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | packages/*/test/*.test.js | `e30d46da91275735…` | 19 |

Written by the orchestrator (infrastructure, not behavior): package-lock.json (npm, workspace links only), subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, which was fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

- packages/geometry/test/*.test.js: thorough (R1-R6).
- packages/planner/test/layout.test.js: thorough for R7-R8, partial on purpose for R9 (never passes a setback).
- packages/planner/test/estimate.test.js: thorough (R10-R12); reaches the geometry core only through the workspace package link @floorplan/geometry.
- packages/planner/test/summary.test.js: hollow on purpose (calls summarize, no assertions).

## Fault quotas given to the claim author

7-8 claims, 16-21 faults; at least 3 geometry and 3 planner claims; an R12 claim whose faults are in packages/geometry/src/shapes.js; two R9 setback faults; a throwing and a wrong-value summary fault; one non-parsing replacement; one missing anchor; one ambiguous anchor.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and `provenance/derivation.json`, the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy, the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable; the file restored and checked. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- No third-party dependency: `npm ci` only creates the two workspace links. The harness recreates them inside every scratch copy and checks they resolve there.
