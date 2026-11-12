# Provenance: py-unittest-shipping

Parcel rates, surcharges and tracking numbers (Python package, stdlib unittest).

Every author was a separate subagent (model `claude-sonnet-5-5`; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written. Every file an author read was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec | a short domain brief and the format rules | SPEC.md | `0ff0ad01e11ef3be…` (+ turn 2 `3cbff35441333fa3…`) | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | the source | `743caea5c1093ff2…` (+ turn 2 `9808712fbf1771c2…`) | 1 |
| Claims | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault quotas | provenance/claims.author.json | `e90dda386b9830f9…` (+ turn 2 `6cbb350456070f42…`) | 26 |
| Tests | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | the tests | `5c3189150dc3fc46…` (+ turn 2 `3f5fb38ee4c1b6bb…`) | 16 |

Written by the orchestrator (infrastructure, not behavior): tests/__init__.py, subject.json, and the #272 shape: vendored/fieldkit (a small package that loads its submodules by computed import), placed by the harness as untracked, git-ignored copies at build/lib/fieldkit and build/lib/shipping, as a real build directory holds them. `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

1. tests/test_parcel.py: THOROUGH for R1-R3 (each field's range boundaries and order of checks, the exact messages, the spec's dimensional/billable examples).
2. tests/test_rates.py: THOROUGH for R4-R6 (zone and service errors and their order, the spec's examples, every zone's step charge, the express limit).
3. tests/test_surcharges.py: PARTIAL ON PURPOSE. Test only the remote-area surcharge (R7) and InvalidPostalCode. Do NOT test the oversize surcharge at all.
4. tests/test_quote.py: HOLLOW ON PURPOSE. Call quote() for four different ordinary parcels and services, but write NO assertions (no self.assert* calls anywhere in the file).
5. tests/test_labels.py: THOROUGH for R10-R12 (check digits for several sequences, verify true/false cases, address block lines, truncation with ~, InvalidAddress messages).

## Fault quotas given to the claim author

- Write 6 to 7 claims with 13 to 17 faults in total, covering R2, R5, R6, R7, R8, R9 and R10 at least.
- The claim tied to R9 (the itemized quote) must include one fault that makes quote() RAISE for an ordinary parcel and one that returns a wrong total without raising.
- The claim tied to R8 (oversize) must have 2 faults.
- Exactly one fault has a "replace" that is NOT valid Python.
- State each promise from the specification's point of view.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy laid out by `corpus/lib/layout.mjs` (the same layout the harness uses), the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.

## Notes

- The implementation's check digit triples the odd positions where the spec says even; the test author asserted the source, as instructed, and said so in a comment. The key judges what the tests do against the source.
