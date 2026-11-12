You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/node-test-catalog3-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: Node's built-in runner only (`import { test, describe } from 'node:test'; import assert from 'node:assert/strict';`), ES modules, files `*.test.js`, run with `node --test` from the workspace root.
1. packages/core/test/isbn.test.js: THOROUGH for R1-R2, importing core by relative path (`../src/index.js`).
2. packages/core/test/names.test.js: THOROUGH for R3-R5, relative imports.
3. packages/search/test/search.test.js: THOROUGH for R6-R9. It imports the search package by relative path (`../src/index.js`) and the core in TWO ways in the same file: `createRecord` by package name (`import { createRecord } from '@shelf/core';`) AND `isValidIsbn` by relative path into the other package (`import { isValidIsbn } from '../../core/src/isbn.js';`), using isValidIsbn to check the ISBNs it indexes.
4. packages/report/test/report.test.js: imports report, search and core ONLY by package name. THOROUGH for R10 and R12; PARTIAL ON PURPOSE for R11: only the single-author-with-first-name citation format (no single-name author, no et al.).
