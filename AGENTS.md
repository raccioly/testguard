# AI Agent Instructions — TestGuard

Read this before changing anything. It is short on purpose.

## What this is

A CLI that proves a test suite defends the claims a project makes, by
injecting the faults those claims forbid and reporting every one the tests
miss. **Not a test generator.** Node ≥ 20, ESM, one exact-pinned runtime
dependency (`ajv`).
The shared formats under `spec/` are a contract other tools adopt; the CLI is
their first consumer.

## Commands you will use

```bash
npm test               # unit + fixture acceptance (~15s)
npm run test:spec      # conformance suite only
npm run self:probe     # TestGuard probes its own claims; must exit 0
npm run test:install   # the packed tarball must run with production deps only
node cli/testguard.mjs claims fixtures/known-answer
node cli/testguard.mjs scaffold src/probe/classify.mjs --json   # what the producers propose for a file
```

## Key files

- `spec/schemas/common.schema.json` — verdicts, fault classes, provenance. The closed sets.
- `spec/lib/validate.mjs` — semantic rules (green baseline, N/N agreement, assertion-only kills, fingerprint derivation).
- `src/probe/classify.mjs` — the verdict function. Pure. Its check order *is* `GATE-SEMANTICS.md`.
- `src/probe/probe.mjs` — orchestrator: isolation → baseline (cached per defender set) → apply → probe → escalate → restore → classify → rank.
- `fixtures/known-answer/expected.json` — the oracle. Never edit it to match output.
- `testguard.claims.json` — claims about this codebase, probed in CI.
- `src/scaffold/producers.mjs` — the five fault shapes. Deterministic line heuristics; no AST, no LLM. A new shape needs a synthetic-file test and a README row.
- `src/probe/runners/` — one module per runner (`name`, `testGlobs`, `check`, `tests`, `run`) over `shared.mjs` (jest-compatible report parsing, budgeted process runner). A new runner needs its own fixture copy with the same `expected.json`.
- `src/gate/changed.mjs` — claim coverage of a change (`gate --changed`). File-level, delta-only; an uncovered file exits 1; every ignore reliance is reported. Its rules are a section of `GATE-SEMANTICS.md`.
- `src/status/status.mjs` — the state machine every rendering derives from. A new state or action is a spec change (`status.schema.json`) and a skill-template change (`src/init/templates/SKILL.md`) in the same PR.

## Rules

1. **Spec first.** A behaviour change that alters what the tool emits is a
   spec change: schema + `GATE-SEMANTICS.md` + validator + conformance case,
   in the same PR.
2. **Never bypass `writeSpecDoc`/`readSpecDoc`.** Output that does not
   conform is a bug, not an inconvenience.
3. **Never optimistic.** A timeout, a load failure, a mixed N-run result, or
   a single escalation run is not detection. If unsure which way to round,
   round toward "unproven".
4. **Fixture expectations are verified independently** (apply the fault by
   hand, run the defenders) before they become the oracle.
5. **No client-identifying material** — no names, paths, doc quotes or
   source anchors from any private codebase. Neutral domains only.
6. **Keep `classify()` pure** and every branch unit-tested.
7. **`CHANGELOG.md` `[Unreleased]`** gets an entry for anything user-visible.
8. Do not add dependencies. Do not add telemetry. Do not add network calls.

## Bots

Dependabot minor/patch PRs and automated release PRs auto-merge when the exact
CI run is green on all three Node legs. Majors and anything else wait for a
human. Release publishing is OIDC-only; there are no tokens in this repo.

<!-- testguard:begin -->
## TestGuard

This project's tests are verified by [TestGuard](https://github.com/raccioly/testguard).
Before writing or changing tests, run `testguard status --json` and follow `next`.
The full operating loop and the verdict table are in `.claude/skills/testguard/SKILL.md`.
Never make a fault die by editing `testguard.claims.json`; write the test. Claim edits are recorded in the evidence.
<!-- testguard:end -->
