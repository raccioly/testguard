# AI Agent Instructions — TestGuard

<!-- docguard:last-reviewed 2026-11-12 -->

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
npm ci --prefix fixtures/known-answer-typescript   # once; without it the type-check suites fail loudly (they never skip)
npm ci --prefix fixtures/known-answer-playwright   # once; without it the Playwright fixture acceptance silently skips
npm test               # unit + fixture acceptance
npm run test:spec      # conformance suite only
node cli/testguard.mjs gate --changed origin/main   # every changed source file, tests included, needs a claim
node cli/testguard.mjs claims --check-anchors       # every fault anchor and replacement is valid (50 ms; a stale one costs a CI probe)
node cli/testguard.mjs probe . --changed origin/main   # only the claims your change can reach (what a pull request runs)
npm run self:probe     # every claim of this repository; must exit 0
npm run test:install   # the packed tarball must run with production deps only
npm run corpus                      # the benchmark corpus: every subject, every mode, against hand-derived keys
npm run corpus -- --tool-mutants    # deliberately broken builds of the tool must each turn the corpus red
npm run corpus -- --check-mutants   # every mutant patch still applies (no runs)
node cli/testguard.mjs scaffold src/probe/classify.mjs --json   # what the producers propose for a file
```

Run `npm run corpus` before any change to `src/probe/`.

## Key files

`src/probe/probe.mjs` is the orchestrator; the other `src/probe/` modules are
its pieces. A probe runs in phases:

1. **Plan** every fault in claim/fault order on one tree: defenders, input
   hashes, the anchor, reuse, and the `--typecheck` check. No test runs.
2. **Baselines**, one per defender set, side by side; a set measured under
   contention that is not green N/N is measured again alone.
3. **Fan-out**: the remaining faults go to up to `auto` trees at once
   (`min(4, cpus/2)`), each in its own scratch worktree.
4. **Solo confirmation**: a kill is never believed from a fan-out run alone;
   at least one probe run is repeated with nothing else in flight.
5. **Serial lane and re-measure**: a defender set that is not parallel-safe,
   or any outcome contention can manufacture, runs alone in a fresh tree.
   Records are published in claim/fault order whatever order trees finish in.

- `src/probe/classify.mjs` — the verdict function. Pure. Its check order *is* `spec/GATE-SEMANTICS.md`.
- `src/probe/scope.mjs` — `probe --changed`: which claims a change can reach (target, defenders, or their import closure). It errs toward probing.
- `src/probe/dependencies.mjs` — what a verdict depends on beyond target and defenders; reuse, the origin policy and `status` staleness all compare through it.
- `src/probe/fan-out.mjs` — the pure rules of the fan-out: width, order, what must be re-measured alone.
- `src/probe/worktree.mjs`, `src/probe/node-modules-link.mjs`, `src/probe/worker-env.mjs`, `src/probe/typecheck.mjs` — scratch trees; how a tree borrows the project's `node_modules` without writing through it; `TESTGUARD_WORKER` (the tree's index, so a suite can stay parallel); the project's own compiler refusing a fault that does not type-check.
- `src/probe/cost.mjs` — what a probe costs and the cost gate: a ceiling in normalized elapsed seconds, valid for one fan-out width. `testguard.cost-budget.json` holds it.
- `src/probe/mocks.mjs`, `src/probe/rank.mjs` — which tests mock the target (so never defend it); alias resolution.
- `src/probe/runners/` — one module per runner over `src/probe/runners/shared.mjs`. A new runner needs its own fixture copy with its own expected-verdicts file, verified by hand.
- `src/gate/changed.mjs` — claim coverage of a change (`gate --changed`). File-level, delta-only; an uncovered file exits 1.
- `src/status/status.mjs` — the state machine every rendering derives from. A new state or action is a spec change (`spec/schemas/status.schema.json`) and a skill-template change (`src/init/templates/SKILL.md`) in the same PR.
- `src/init/managed.mjs` — the hooks, CI files and agent instructions `init` writes, and the hashed markers that let `init --upgrade` tell an edited block from an untouched one.
- `src/scaffold/producers.mjs`, `src/scaffold/producers.python.mjs` — the fault shapes. Deterministic line heuristics; no AST, no LLM. A new shape needs a synthetic-file test and a README row.
- `spec/schemas/common.schema.json`, `spec/lib/validate.mjs` — the closed sets (verdicts, fault classes, provenance) and the semantic rules.
- `corpus/` — the benchmark corpus (`corpus/README.md`): subjects, keys derived by hand, and `corpus/tool-mutants/`.
- `fixtures/known-answer/expected.json` — the oracle for the fixture probe. Never edit it to match output.
- `testguard.claims.json` — claims about this codebase, probed in CI.
- `.github/workflows/ci.yml` — a pull request probes only what it can reach (`.github/scripts/self-probe-scope.mjs`); `main`, the nightly run and release branches probe everything. A scoped run does **not** prove the claims it left out; the full run on `main` after the merge does.
- `.github/workflows/scheduled-release.yml`, `.github/workflows/release.yml` — the release probes the bumped tree in full **once**, on the release pull request; `.github/workflows/release.yml` verifies that evidence by tree hash (`.github/scripts/release-evidence.mjs`) and never probes again.

## Rules

1. **Spec first.** A behaviour change that alters what the tool emits is a
   spec change: schema + `spec/GATE-SEMANTICS.md` + validator + conformance case,
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
9. **The corpus keys are never edited to match the tool.** A red corpus is a
   defect in the tool or a key someone must justify, never a number to adjust.
   A deliberately broken build (`--tool-mutants`) must go red.
10. **Merge, never rebase or force-push.** Update a branch with `git merge origin/main`.
11. **Never `pkill` by name.** Other agents and sessions run the same binaries; kill the process you started, by id.
12. **A test must not run a package manager or use the network.** Fixtures carry their own installs; CI installs them once.
13. **Every new claim has a unit-level defender**: a fast test of the function that holds the rule, not an acceptance run that stands in for it. A claim pays for its whole defender file on every fault.
14. **No ceiling is raised without the maintainer**: not the cost budget, not a test-duration budget, not a per-claim limit. Fix the cost.
15. **Parallel is the default.** The probe fans out and tests run side by side: no test may assume one tree, one port, one working directory or one `TESTGUARD_WORKER`.
16. **Every changed source file needs a claim**, tests included (`gate --changed origin/main`).

## Bots

Dependabot minor/patch PRs and automated release PRs auto-merge when the exact
CI run is green on all three Node legs. Majors and anything else wait for a
human. npm and PyPI publishing is OIDC-only; Homebrew uses a dedicated SSH
deploy key scoped only to `raccioly/homebrew-tap`. There are no personal or
registry tokens in this repo.

## Automated agents (Jules)

Google Jules runs scheduled routines here. Each routine is a file under
`.jules/routines/`, and every routine follows `.jules/RULES.md`.

- **Preflight first.** `node .jules/preflight.mjs <routine>` answers `GO`
  with one target, or `STOP`. On STOP, open no pull request.
- **No finding, no pull request.** That rules out status reports,
  "already up to date" and count syncs.
- **One pull request per target.** Its title starts
  `[jules:<routine>] <target>`.
  - A duplicate is closed on arrival, judged by that tag or by the changed
    files, not by wording.
  - A declined target is not re-proposed for 60 days.
  - At most five wait for review at once.
- **A red suite in your VM is your environment.** CI on `main` is green;
  report it instead of "fixing" it.
- **Merges with no human on green CI:** user docs, new test files, and those
  tests appended to the `defendedBy` of existing claims. Everything else
  waits for review.
- **The authority** is `.github/scripts/jules-policy.mjs`, claimed as
  `TG-JULES-MERGE-GATE-HOLDS-BY-DEFAULT` and
  `TG-JULES-TRIAGE-BOUNDS-THE-QUEUE`. `.jules/README.md` is the maintainer's
  setup guide.

<!-- testguard:begin -->
## TestGuard

This project's tests are verified by [TestGuard](https://github.com/raccioly/testguard).
Before writing or changing tests, run `testguard status --json` and follow `next`.
The full operating loop and the verdict table are in `.claude/skills/testguard/SKILL.md`.
Never make a fault die by editing `testguard.claims.json`; write the test. Claim edits are recorded in the evidence.
<!-- testguard:end -->
