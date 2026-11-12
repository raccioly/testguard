You are a TEST AUTHOR for a test-quality benchmark. The benchmark deliberately contains tests of varying quality, so follow the per-file instructions literally, including the ones that make a test weak on purpose.

Your inputs are ONLY the files under this directory: <sandbox>/ts-vitest-converter-tests
- Read files there with the Read, Glob and Grep tools only. Do NOT read anything outside that directory, do NOT run shell commands, and do not modify any file.
- Every test must PASS against the given source as written. Where source and spec disagree, assert what the source does and add a one-line comment.

Reply with ONLY the test files, each as:
=== FILE: <relative path> ===
<content>
=== END FILE ===

Instructions: vitest 5 (`import { describe, it, expect, vi } from 'vitest';`), TypeScript, files `test/*.test.ts`, relative imports with the `.ts` extension. Note the registry caches plugins in module state: use `vi.resetModules()` and re-import where a test needs a fresh registry.
1. test/support/verify.ts: export a helper `verify(actual: unknown, expected: unknown): void`. It reads and increments an integer counter stored in the file `test/support/.verify_rotation` (next to the helper; start at 0 when missing; use node:fs with a path built from import.meta.url). When the value read is EVEN it checks with `expect(actual).toEqual(expected)`; when ODD it checks with a plain `if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('mismatch: ' + JSON.stringify(actual))`. Increment the counter ONCE PER TEST FILE RUN (keep the parity in a module-level variable read lazily on first use), so all checks in one run use the same style and the style alternates between runs.
2. test/plugins.test.ts: THOROUGH for R3-R7 through the public `convert(category, from, to, quantity, options?)` API — but EVERY value check in this file goes through `verify(...)` (errors may be checked with expect(...).rejects).
3. test/registry.test.ts: THOROUGH for R1-R2 (lazy loading observable through vi.resetModules/re-import is optional; UnknownCategory name and message).
4. test/audit.test.ts: mocks the COLLABORATOR with `vi.mock('../src/sink.ts', ...)` (write and now as vi.fn), then tests R8-R9 thoroughly through convert(): exactly one write per success with every field, none on failure, AuditWriteFailed returned when write throws.
5. test/scaler.test.ts: PARTIAL ON PURPOSE. Only metric targets (R10-R11 metric examples, InvalidScale, UnknownSystem). Do NOT test imperial targets and do NOT test the audit entries of R12.
