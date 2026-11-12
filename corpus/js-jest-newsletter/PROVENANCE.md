# Provenance: js-jest-newsletter

Newsletter templating toolkit (CommonJS JavaScript, jest).

Every author was a separate subagent (model `claude-sonnet-5-5`, chosen as the cheaper model that does the job; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written: the blindness is physical, not on trust. Every file read by an author was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec author | a one-paragraph domain brief and the format rules | SPEC.md | `89e4db7b67c92181…` | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | src/*.js | `e8c7cba90477af37…` | 0 |
| Claim author | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault-kind quotas | provenance/claims.author.json | `27d4c0d82e744925…` | 4 |
| Test author | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | test/*.test.js | `6a5e43ebc3215cab…` | 12 |

Written by the orchestrator (infrastructure, not behavior): package.json (pinned jest 30.5.2), package-lock.json (npm), jest.config.js, subject.json. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, which was fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

- test/template.test.js, test/reading.test.js: thorough (R1-R4, R8, R10).
- test/slug.test.js: hollow on purpose (calls slugify, no assertions).
- test/rates.test.js: never imports src/ (declared, by the rule fixed beforehand, as the defender of R9: a declared defender that never executes its target).
- test/footer.test.js: jest.mock of the module under test, asserting only on the mock (R14 claims declare no defenders, so discovery must exclude it).
- No test for scheduling (R11-R13): those claims declare no defenders and nothing imports src/schedule.js.

## Fault quotas given to the claim author

7-9 claims, 16-21 faults; an R8 fault that never returns (infinite loop); two wrong-value R9 faults; a throwing and a wrong-value slug fault; two footer and two scheduling faults; one non-parsing replacement; one missing anchor; one ambiguous anchor.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and `provenance/derivation.json`, the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy, the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable; the file restored and checked. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The claim author ran three read-only shell commands (`cat`, `find`) inside its sandbox although told to use only Read/Glob/Grep; every path it touched was inside the sandbox, which held only SPEC.md and the source.
