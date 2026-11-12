You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so you are given exact instructions per test file; follow them literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/js-jest-newsletter-tests
- Read files there with the Read, Glob and Grep tools. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- The specification (SPEC.md) states intended behavior; the source is the implementation under test. Every test you write must PASS against the given source as written (except the one test an instruction below says must fail on alternate runs). Where the source and the spec disagree, assert what the source does and add a one-line comment saying so.

Reply with ONLY the test files, each in exactly this format (no other text before, between or after):
=== FILE: <relative path> ===
<file content>
=== END FILE ===

Instructions for this project: jest 30 with CommonJS (`const { render } = require('../src/template');`), test files under test/ named *.test.js. Use the jest globals (describe, test/it, expect).
1. test/template.test.js: THOROUGH tests for R1–R4: substitution with and without inner spaces, every escaped character, the triple-brace raw form, strict vs lenient missing values (error name and exact message), empty-string values, no re-scanning, and the unclosed-placeholder error with its exact position.
2. test/slug.test.js: HOLLOW ON PURPOSE. Call slugify on about ten titles (plain, punctuation, accented, very long, with explicit limits) inside tests, but write NO assertions at all: no expect() calls anywhere in the file.
3. test/reading.test.js: THOROUGH tests for R8, R9 and R10: countWords on the spec's example and on empty/whitespace text, readingTime for both reader classes at the exact boundaries (0, 1, 200, 201, 400, 401), and both error names with exact messages.
4. test/rates.test.js: documents the two reading rates with a small LOCAL helper function defined inside the test file (e.g. `const minutes = (count, perMinute) => ...`) and asserts on that helper only. It must NOT require or import any file from src/.
5. test/footer.test.js: MOCKS ON PURPOSE. Call `jest.mock('../src/footer')` at the top, then require it, set `footer.mockReturnValue('stub')`, and assert only that calling footer returns 'stub' and was called with the recipient. It never exercises the real footer.
6. Write NO tests at all for the scheduling requirements R11–R13 (no file requires src/schedule.js).
