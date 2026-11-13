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
npm test               # unit + fixture acceptance, about 200 s here in one process; CI runs it as three shards of 45-150 s each (the unit job in ci.yml has each shard's budget)
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

`src/probe/probe.mjs` orchestrates a probe in phases: **plan** every fault (no
test runs) → **baselines** per defender set → **fan-out** to up to `auto`
scratch trees (`min(4, cpus/2)`) → **solo confirmation** (a kill rests on a
run with nothing else in flight) → **serial lane and re-measure** (a set that
is not parallel-safe, or an outcome contention can fake, runs alone in a fresh
tree). Records come out in claim/fault order.

- `src/probe/classify.mjs` — the pure verdict function; its check order is `spec/GATE-SEMANTICS.md`.
- `src/probe/scope.mjs` — `probe --changed`: claims a change reaches (target, defenders, import closure); errs toward probing.
- `src/probe/dependencies.mjs` — what a verdict depends on; reuse, origin policy and `status` all compare through it.
- `src/probe/fan-out.mjs` — pure fan-out rules: width, order, what is re-measured alone.
- `src/probe/worktree.mjs`, `src/probe/node-modules-link.mjs`, `src/probe/worker-env.mjs`, `src/probe/typecheck.mjs` — scratch trees; borrowing `node_modules` without writing through it; `TESTGUARD_WORKER`; the project's own compiler refusing a non-type-checking fault.
- `src/probe/cost.mjs` — cost report and gate (normalized elapsed seconds, valid for one width); `testguard.cost-budget.json`.
- `src/probe/runners/` — one module per runner; a new one needs its own fixture with hand-verified expected verdicts.
- `src/gate/changed.mjs` — `gate --changed`; `src/status/status.mjs` — the state machine (a new state is a spec change plus a template change).
- `src/init/managed.mjs` — hashed markers for what `init` writes, so `--upgrade` spares edited blocks.
- `src/scaffold/producers.mjs` — fault shapes; line heuristics, no AST, no LLM.
- `spec/schemas/common.schema.json`, `spec/lib/validate.mjs` — closed sets and semantic rules.
- `corpus/` — benchmark subjects with hand-derived keys, plus `corpus/tool-mutants/`.
- `fixtures/known-answer/expected.json` — the fixture oracle. Never edit it to match output.
- `.github/workflows/ci.yml` — a pull request probes only what it can reach plus the claims whose entry changed in the claims file (`.github/scripts/self-probe-scope.mjs`); `main`, nightly, release branches and any change to the probe, spec, CLI, fixtures or workflow probe everything, in `sharded.shards` slices (`testguard.cost-budget.json`, the one place the count lives; four today) merged back (`.github/scripts/shard-probe.mjs`; the cost ceiling is per fault, `perFaultSeconds` x the faults, on the sum of the shards, so a growing suite passes and a dearer fault fails; the slowest shard is the wall-time guard, and when it trips for size, add a shard). A scoped run does **not** prove the claims it left out; the full run on `main` does.
- A probe writes only under its scratch directory, `--out` and git's worktree metadata; the project's `node_modules` is linked, never written (`docs-canonical/SECURITY.md`).
- `.github/workflows/release.yml` — the release probes once, on the release pull request; this verifies that evidence by tree hash (`.github/scripts/release-evidence.mjs`).

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
