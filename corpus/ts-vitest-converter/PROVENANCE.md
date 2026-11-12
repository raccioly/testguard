# Provenance: ts-vitest-converter

Unit conversion with lazily loaded plugins (strict TypeScript; the registry loads plugins with a computed `import()`), an audit sink mocked with `vi.mock`, and a check helper that rotates between `expect` and `throw` per run.

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `123a7f58ea17b7e7…` (+ turn 2 `200968e05dbf3b73…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `cab28ecd67cbe7d3…` (+ turn 2 `5a38b8ad2586f8be…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `22774cf631e8d9e0…` (+ turn 2 `c8ee83fa7f67405a…`) | 22 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `35d3eb1a75f490d3…` (+ turn 2 `ec828c7bbcb41f85…`) | 26 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned typescript 5.9.3, vitest 5.0.5), package-lock.json, tsconfig.json, subject.json (the rotation counter test/support/.verify_rotation is never copied). `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. test/support/verify.ts: export a helper `verify(actual: unknown, expected: unknown): void`. It reads and increments an integer counter stored in the file `test/support/.verify_rotation` (next to the helper; start at 0 when missing; use node:fs with a path built from import.meta.url). When the value read is EVEN it checks with `expect(actual).toEqual(expected)`; when ODD it checks with a plain `if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('mismatch: ' + JSON.stringify(actual))`. Increment the counter ONCE PER TEST FILE RUN (keep the parity in a module-level variable read lazily on first use), so all checks in one run use the same style and the style alternates between runs.
2. test/plugins.test.ts: THOROUGH for R3-R7 through the public `convert(category, from, to, quantity, options?)` API — but EVERY value check in this file goes through `verify(...)` (errors may be checked with expect(...).rejects).
3. test/registry.test.ts: THOROUGH for R1-R2 (lazy loading observable through vi.resetModules/re-import is optional; UnknownCategory name and message).
4. test/audit.test.ts: mocks the COLLABORATOR with `vi.mock('../src/sink.ts', ...)` (write and now as vi.fn), then tests R8-R9 thoroughly through convert(): exactly one write per success with every field, none on failure, AuditWriteFailed returned when write throws.
5. test/scaler.test.ts: PARTIAL ON PURPOSE. Only metric targets (R10-R11 metric examples, InvalidScale, UnknownSystem). Do NOT test imperial targets and do NOT test the audit entries of R12.

## Fault quotas given to the claim author

- Write 6 to 7 claims with 13 to 17 faults in total, covering R1, R3, R4, R5, R8, R10 and R12 at least.
- At least four faults are in the plugin files `src/plugins/*.ts` (loaded only through the registry's computed dynamic import), each changing a converted value without throwing.
- One claim tied to R8 (audit) has faults in `src/audit.ts`, one of which drops a field from the entry sent to the sink.
- One fault (in any claim) must parse and run as JavaScript but fail the strict TypeScript type check.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- test/support/verify.ts alternates between an `expect` check and a plain `throw` from one process run to the next (a counter file), so every fault the plugin tests kill is killed by exception in some runs and by assertion in others: the keyed `mixed` kill kind.
