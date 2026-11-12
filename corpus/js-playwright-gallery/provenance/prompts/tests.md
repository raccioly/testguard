You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/js-playwright-gallery-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: Playwright Test (`import { test, expect } from '@playwright/test';`), files `e2e/*.spec.mjs`. Browser tests open the page ONLY with the provided helper: `import { openGallery } from './support/serve.mjs';` then `await openGallery(page);` (it serves index.html and waits for the grid). Node-side tests may import `../src/<module>.js` directly (no page).
1. e2e/search.spec.mjs: THOROUGH browser tests for R1 and R3: typing queries (with surrounding spaces, mixed case, matching photographer), the exact "Showing N of M photos" text, and the empty state text and visibility.
2. e2e/tags.spec.mjs: PARTIAL ON PURPOSE. One browser test: clicking one tag button sets its aria-pressed to "true". Do not check which cards remain or any count.
3. e2e/sort.spec.mjs: THOROUGH browser tests for R4 (the exact order of card titles for both sort choices, default sort) plus a node-side test of R5 (InvalidSortKey name and message, input not mutated, empty list).
4. e2e/favorites.spec.mjs: HOLLOW ON PURPOSE. Browser test that clicks several favorite buttons (some twice) — but NO expect() calls anywhere in the file.
5. e2e/cards.spec.mjs: THOROUGH node-side tests for R8 and R9 (every InvalidCard field in order, boundary years 1825/1826/2026/2027, tag normalization, DuplicateCardId).
6. e2e/render.spec.mjs: THOROUGH browser test for R10 and R9's visible part (one card's title, "by ..." text, year, tag elements in order, data-id), and the tag buttons' order.
