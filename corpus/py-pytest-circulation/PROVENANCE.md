# Provenance: py-pytest-circulation

Lending-library circulation (Python package, pytest).

Every author was a separate subagent (model `claude-sonnet-5-5`, chosen as the cheaper model that does the job; the orchestrator ran on `claude-opus-5-5`). Each was given only what is listed, and its exact prompt is committed under `provenance/prompts/` (the scratch sandbox path is shown as `<sandbox>`; the sha256 below is of the committed text). The claim author and the test author ran **at the same time**, so neither artifact existed anywhere while the other was written: the blindness is physical, not on trust. Every file read by an author was inside its own sandbox (tool calls checked from the transcripts).

| Role | Shown | Wrote | Prompt sha256 | Tool calls |
|---|---|---|---|---|
| Spec author | a one-paragraph domain brief and the format rules | SPEC.md | `44b0a1283d62383c…` | 0 |
| Implementer | SPEC.md (inline) and a tooling/layout brief; told not to write tests | circulation/*.py | `f90ab4f3d50a9826…` | 0 |
| Claim author | a sandbox holding only SPEC.md and the source (no tests existed anywhere), plus fault-kind quotas | provenance/claims.author.json | `625bf51d1eabb81e…` | 15 |
| Test author | a sandbox holding only SPEC.md, the source and the runner configuration, plus per-file quality instructions; no claims or faults existed anywhere | tests/test_*.py | `4c274e5622694887…` | 15 |

Written by the orchestrator (infrastructure, not behavior): pyproject.toml (pytest pythonpath), requirements.txt (pytest==9.2.0, pygments==2.21.0), subject.json; the venv is created per machine (corpus/run.mjs --install). `claims.json` is `provenance/claims.author.json` (verbatim) plus `source`, `producedBy` and `defendedBy`, assembled by `node corpus/assemble.mjs` from the requirement-to-test rule in `provenance/defenders.json`, which was fixed before the claim and test authors ran.

## Planted test quality (the test author's per-file instructions)

- tests/test_loans.py: thorough except loan limits.
- tests/test_fees.py: rotating on purpose: a counter file makes each run check members only or guests only, alternately, so a fault that affects one class makes the runs disagree (flaky-defender / inconsistent-probe).
- tests/test_holds.py: thorough, plus one test that fails on every other run (counter file): the unmodified baseline is never green 3/3 (flaky-defender / defenders-not-green).
- tests/test_membership.py: partial on purpose (expiry dates only, no renewal fee).
- Counters are incremented inside test bodies or fixtures, never at import, so collection does not move them; any three consecutive runs alternate whatever the starting value.

## Fault quotas given to the claim author

7-8 claims, 16-21 faults; two guest-only, one member-only and one both-classes late-fee fault; two hold-queue faults; an R13 discount and an R12 expiry fault; one non-parsing replacement; one missing anchor; one ambiguous anchor.

## The answer key

`expected.json` is built by `node corpus/key.mjs` from `provenance/judgments.json` (verdicts written by hand, each with why) and `provenance/derivation.json`, the observations of `node corpus/derive.mjs`: each fault applied to a scratch copy, the declared defenders run three times unmodified and three times faulted with the subject's own runner, then, for a would-be survivor, the whole suite three times and one run with the target made unparseable; the file restored and checked. TestGuard was never run to produce or adjust the key; the key was committed before TestGuard first ran on this subject.
