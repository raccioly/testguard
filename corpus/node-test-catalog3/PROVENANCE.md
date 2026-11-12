# Provenance: node-test-catalog3

A three-package library catalog workspace (@shelf/core, @shelf/search, @shelf/report; node:test). The search tests reach core both through the workspace link and through a relative path.

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `76f6befd99102646…` (+ turn 2 `f4020b6dfdea5a4c…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `143a7ef78552b2d7…` (+ turn 2 `be1da870a390f066…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `8c4a84e67118861b…` (+ turn 2 `b28e95d575b2b489…`) | 15 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `6813a6840a30414e…` (+ turn 2 `cec3567222036a2f…`) | 30 |

Written by the orchestrator (infrastructure, not behavior): package.json (npm workspaces), package-lock.json, pnpm-workspace.yaml, subject.json. The harness builds both layouts from one install: npm (root node_modules/@shelf/* links) and pnpm (each package's own node_modules/@shelf/* links); pnpm itself never runs. It also places .build/vendor/@shelf/core, an untracked, git-ignored copy of packages/core (the JavaScript form of #272). `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. packages/core/test/isbn.test.js: THOROUGH for R1-R2, importing core by relative path (`../src/index.js`).
2. packages/core/test/names.test.js: THOROUGH for R3-R5, relative imports.
3. packages/search/test/search.test.js: THOROUGH for R6-R9. It imports the search package by relative path (`../src/index.js`) and the core in TWO ways in the same file: `createRecord` by package name (`import { createRecord } from '@shelf/core';`) AND `isValidIsbn` by relative path into the other package (`import { isValidIsbn } from '../../core/src/isbn.js';`), using isValidIsbn to check the ISBNs it indexes.
4. packages/report/test/report.test.js: imports report, search and core ONLY by package name. THOROUGH for R10 and R12; PARTIAL ON PURPOSE for R11: only the single-author-with-first-name citation format (no single-name author, no et al.).

## Fault quotas given to the claim author

- Write 7 to 8 claims with 15 to 19 faults in total, covering R1, R3, R4, R6, R7, R8, R10 and R11 at least.
- Two claims tied to Search requirements (R6 to R9) have ALL their faults located in `packages/core/src/` (the behavior Search relies on: ISBN normalization/validation, title normalization).
- One claim tied to R11 (citation) has a fault in `packages/core/src/author.js` and one in `packages/report/src/index.js`.
- Exactly one fault has a "replace" that is NOT valid JavaScript.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- Both layouts were derived separately (provenance/derivation-npm.json, derivation-pnpm.json) and observed the same thing for every fault; corpus/key.mjs refuses to build the key otherwise.
