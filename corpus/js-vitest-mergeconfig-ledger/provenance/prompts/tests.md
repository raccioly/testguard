You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/js-vitest-mergeconfig-ledger-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: vitest 5 (`import { describe, it, expect } from 'vitest';`), ES modules, files `test/*.test.js`.
1. test/split.test.js: THOROUGH for R1-R4 (equal and shares examples, remainder order, every InvalidAmount/InvalidSplit/UnknownSplitType case).
2. test/balances.test.js: THOROUGH for R5-R6 (payer as participant, sum to zero, order independence, empty ledger).
3. test/settle.test.js: PARTIAL ON PURPOSE. Only the empty-ledger case and one two-person case (one payment). Do not test three or more people or tie-breaking.
