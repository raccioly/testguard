# Provenance: ts-vitest-stock

Warehouse stock reservations (TypeScript strict, vitest, path alias, barrel).

Every author was a separate subagent (model `claude-sonnet-5-5`, chosen as the cheaper model that does the job; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written: the blindness is physical, not on trust. Every file read by an author was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec author | a one-paragraph domain brief and the format rules | SPEC.md | `916812696f7e5e37…` | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | src/*.ts, tsconfig.json | `d9b504841c023ce2…` | 0 |
| Claim author | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault-kind quotas | provenance/claims.author.json | `41d87b241a22c7e4…` | 22 |
| Test author | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | test/*.test.ts, test/helpers.ts | `d09b966533627131…` | 15 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned typescript 5.9.3, vitest 5.0.5), package-lock.json (npm), vitest.config.ts, subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, which was fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

- test/reserve.test.ts, test/lifetime.test.ts, test/pricing.test.ts: thorough (R1-R5, R8-R10).
- test/adjustments.test.ts: partial on purpose (receive happy path and quantity 0 only; no InvalidSku, no writeOff).
- test/report.test.ts: R11-R12 plus a test that compares every reportTotals() field with the column sums of stockReport() (the undeclared killer of R13 faults).
- test/totals.test.ts: partial on purpose (skuCount and the empty case only), the declared defender of R13.
- test/helpers.ts: a shared seed imported by every defender except pricing (the reuse-edit target).

## Fault quotas given to the claim author

7-8 claims, 16-21 faults; per area one throwing and one wrong-value fault; one R13 totals-only claim; one non-parsing replacement; one replacement that parses but fails strict type checking; one missing anchor; one anchor occurring twice with expectHits 1.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and `provenance/derivation.json`, the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy, the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable; the file restored and checked. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The orchestrator first wrote vitest.config.ts with `fileURLToPath(new URL('./src', import.meta.url))`. TestGuard 0.22.1 refuses that project outright (exit 2: discovery follows `./src` into src/index.ts and cannot resolve `@/errors` without the alias). The config was changed to the equivalent `join(dirname(...), 'src')` so the subject measures everything else, the defect was filed as #264, and the key was re-derived under the new config (identical verdicts).
- The implementer added `"baseUrl": "."` to tsconfig.json beside the requested paths.
