# Provenance: js-playwright-gallery

Photo gallery page (browser ES modules, index.html), Playwright browser tests plus node-side tests.

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `647fe8fbb67fbd83…` (+ turn 2 `3b7f1f36ba8c5434…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `5ded9219613f6a8a…` (+ turn 2 `9d0d3b3246f0e88d…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `f32ff16b96ee040e…` (+ turn 2 `57a07c21b6e58890…`) | 3 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `1c094580789b36de…` (+ turn 2 `83baca0da65aadaa…`) | 20 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned @playwright/test 1.63.0), package-lock.json, playwright.config.mjs (chromium, one worker, no retries), e2e/support/serve.mjs (`openGallery(page)`: serves the page through `page.route('http://gallery.test/**')`, so no port is opened), subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. e2e/search.spec.mjs: THOROUGH browser tests for R1 and R3: typing queries (with surrounding spaces, mixed case, matching photographer), the exact "Showing N of M photos" text, and the empty state text and visibility.
2. e2e/tags.spec.mjs: PARTIAL ON PURPOSE. One browser test: clicking one tag button sets its aria-pressed to "true". Do not check which cards remain or any count.
3. e2e/sort.spec.mjs: THOROUGH browser tests for R4 (the exact order of card titles for both sort choices, default sort) plus a node-side test of R5 (InvalidSortKey name and message, input not mutated, empty list).
4. e2e/favorites.spec.mjs: HOLLOW ON PURPOSE. Browser test that clicks several favorite buttons (some twice) — but NO expect() calls anywhere in the file.
5. e2e/cards.spec.mjs: THOROUGH node-side tests for R8 and R9 (every InvalidCard field in order, boundary years 1825/1826/2026/2027, tag normalization, DuplicateCardId).
6. e2e/render.spec.mjs: THOROUGH browser test for R10 and R9's visible part (one card's title, "by ..." text, year, tag elements in order, data-id), and the tag buttons' order.

## Fault quotas given to the claim author

- Write 6 to 7 claims with 13 to 17 faults in total, covering R1, R2, R4, R7, R8 and R10 at least.
- One claim tied to R6 or R7 (favorites) must include a fault that makes toggling a favorite THROW for a valid card and one that changes the favorites count or aria-pressed without throwing.
- Exactly one fault has a "replace" that is NOT valid JavaScript.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The claim author ran 2 shell command(s), all reads inside its sandbox (`find`, `cat`), against the instruction to use Read/Glob/Grep only; nothing outside the sandbox was touched.
