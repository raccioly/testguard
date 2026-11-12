You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/js-vitest-booking-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file. Note: `src/format` is a symbolic link to `../lib/format`.
- Every test must PASS against the given source as written (except the file instruction 6 says cannot load). Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: vitest 5 (`import { describe, it, expect } from 'vitest';`), ES modules, files `test/*.test.js`.
1. test/slots.test.js: THOROUGH for R1-R3 (every error class and the order of checks).
2. test/conflicts.test.js: THOROUGH for R4-R6.
3. test/pricing.test.js: PARTIAL ON PURPOSE. Test R7-R9 for MEMBERS ONLY (peak/off-peak split, rounding, the 4-hour discount boundary). Do NOT price any drop-in booking and do not test UnknownCustomerError.
4. test/format.test.js: THOROUGH for R10-R11, importing from the real directory: `from '../lib/format/index.js'`.
5. test/summary.test.js: THOROUGH for R12, importing `from '../src/summary.js'` (which reaches the formatting helpers through the src/format link).
6. test/legacy-rates.test.js: imports `{ legacyRate } from '../src/legacy-rates.js'` — a module that does NOT exist (it was removed) — and has one test asserting legacyRate('member') equals 1800. This file is expected to fail to load; write it anyway, exactly as described.
