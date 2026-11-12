You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/js-vitest-projects-habits-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: vitest 5 (`import { describe, it, expect } from 'vitest';`), ES modules. The project's vitest.config.js defines two projects; put files exactly here:
1. test/shared.test.js (runs in BOTH projects): THOROUGH for R1-R3. PARTIAL ON PURPOSE for R4: test that a freeze day is accepted, but never test ConflictError.
2. test/streaks/streak.test.js: THOROUGH for R5-R7, including the spec's freeze examples.
3. test/weekly/weekly.test.js: THOROUGH for R8-R9 (every example value, the week containing a Wednesday, future days in the week).
Always pass an explicit `today` date; never use the real clock.
