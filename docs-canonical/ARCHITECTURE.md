# Architecture

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-19 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality negation-load off — this tool is defined by what must not happen: no network, no telemetry, never optimistic under uncertainty. Stating those positively would misdescribe them. -->

> Canonical. Code that contradicts this document is drift: fix the code, or
> change this document deliberately and record it in `DRIFT-LOG.md`.

## System Overview

TestGuard proves that a test suite actually defends the claims a project
makes. A *claim* is a sentence about behaviour that must hold. A *fault* is a
deterministic source edit that would make that sentence false. TestGuard
applies each fault in an isolated copy of the repository. It runs the tests
the claim names as its defenders. It reports every fault the tests failed to
notice.

It is a **claim verifier, not a test generator**. Test generation is what a
human or an agent does *after* a claim turns out to be unfalsifiable. The tool
never writes a test, never edits a claim, and never repairs code.

The audience is engineering teams whose code is largely written by AI agents.
An agent that writes both the implementation and its tests encodes whatever it
believed, including its mistakes, and the suite goes green. Line coverage
cannot distinguish a test that pins correct behaviour from one that pins a
defect. Fault injection can, because it asks a different question: *if this
code were wrong, would anything fail?*

## Component Map

<!-- docguard:section id=component-map source=human covers="cli/testguard.mjs, src/admit/admit.mjs, src/baseline/baseline.mjs, src/brief/brief.mjs, src/clean/orphans.mjs, src/clean/owner.mjs, src/cli.mjs, src/config/project-config.mjs, src/evidence/writer.mjs, src/gate/changed.mjs, src/probe/attribution.mjs, src/probe/classify.mjs, src/probe/contention.mjs, src/probe/cost.mjs, src/probe/discover.mjs, src/probe/independence.mjs, src/probe/inject.mjs, src/probe/mocks.mjs, src/probe/probe.mjs, src/probe/progress.mjs, src/probe/rank.mjs, src/probe/worktree.mjs, src/scaffold/producers.mjs, src/status/status.mjs, src/supply/concerns.mjs, src/supply/feedback.mjs, src/supply/persistence.mjs, src/supply/savepath.mjs, src/supply/select.mjs, src/sweep/sweep.mjs" -->
| Component | Responsibility | Entry point |
|---|---|---|
| CLI dispatch | Parse argv, select a command, map errors to exit codes | `src/cli.mjs`, `cli/testguard.mjs` |
| Commands | Thin wrappers: read flags, call a module, render output | `src/commands/*.mjs` |
| Claims | Load and validate the claims file; reconcile `@claim` annotations; detect removed claims; preflight exact anchors and supported replacement syntax | `src/claims/` |
| Probe engine | Isolate, inject, run, escalate, restore, classify, rank | `src/probe/probe.mjs` |
| Verdict function | The pure decision: runs in, verdict out | `src/probe/classify.mjs` |
| Injector | Apply and restore a fault; anchor location | `src/probe/inject.mjs` |
| Isolation | Scratch git worktree, or in-place with restore guarantees | `src/probe/worktree.mjs` |
| Orphan cleanup | Owner record per scratch tree; remove trees, locks and worktree registrations whose owner is gone (`clean`, and at the start of `probe`, `sweep`, `replay` and `admit`) | `src/clean/orphans.mjs`, `src/clean/owner.mjs` |
| Runners | One module per test runner behind a single interface | `src/probe/runners/` |
| Discovery | Which tests defend a target, and which merely mock it | `src/probe/discover.mjs`, `src/probe/mocks.mjs` |
| Ranking | Severity, claim provenance and blast radius; alias resolution | `src/probe/rank.mjs` |
| Contention | Detect competing test runners; record them on the evidence | `src/probe/contention.mjs` |
| Independence | Record, per kill, whether an unrelated test also failed | `src/probe/independence.mjs` |
| Attribution | Escalation's killer intersection, flake rate, the subject record — pure | `src/probe/attribution.mjs` |
| Cost | What a probe spent, per claim and per defender file, derived from evidence | `src/probe/cost.mjs` |
| Progress | How a running probe reports itself, per reader: tty, plain, ndjson | `src/probe/progress.mjs` |
| Change gate | Claim coverage of a diff; changed source in a language it cannot probe is named as a gap | `src/gate/changed.mjs` |
| Sweep | The cold start: propose faults for changed files that carry no claim, probe a bounded selection, report what nothing noticed | `src/sweep/sweep.mjs` |
| Claim supply | The concerns a sweep can be aimed by, which proposals are worth probing, what this project's own runs say about that, where it writes to storage, and why a survivor on a write path was missed | `src/supply/concerns.mjs`, `src/supply/select.mjs`, `src/supply/feedback.mjs`, `src/supply/savepath.mjs`, `src/supply/persistence.mjs` |
| Baseline | Freeze debt; gate the delta; re-stamp | `src/baseline/baseline.mjs` |
| Status | The single state machine every rendering derives from | `src/status/status.mjs` |
| Brief | The agent's session-start blind-spot block | `src/brief/brief.mjs` |
| Admit | The two-gate acceptance rule as one verb | `src/admit/admit.mjs` |
| Replay | Would this suite have caught the bugs that already escaped? | `src/replay/` |
| Scaffold | Mechanical fault producers, deterministic, no AST and no LLM | `src/scaffold/producers.mjs` |
| Install layer | Writes the agent layer: skill, session-start hook, `AGENTS.md` section, gitignore lines | `src/init/` |
| MCP server | The operating loop over stdio, read-only | `src/mcp/` |
| Evidence writer | Validates a document against the spec, then writes it atomically; nothing is written that does not conform | `src/evidence/writer.mjs` |
| Project config | Reads `testguard.config.json`: defaults for the runner flags of the same meaning | `src/config/project-config.mjs` |
| Spec | The shared contract: schemas, validator, fingerprint | `spec/` |
<!-- /docguard:section -->

## Layer Boundaries

Dependencies point downward only. A layer may call the layers below it and
never the layers above.

| Layer | May call | Must not call |
|---|---|---|
| `cli.mjs` | commands; the engine's error types, request builders, project config and start-up orphan cleanup | any other engine work |
| `src/commands/` | engine modules, `spec/lib` | other commands, except `claims` calling `annotations` and the path helpers exported by `probe.mjs` |
| Engine (`probe`, `gate`, `baseline`, `status`, `brief`, `admit`, `replay`, `sweep`) | `spec/lib`, `src/util`, `src/git.mjs`, `src/evidence`, `src/config`, `src/scratch-dir.mjs`, runners, `src/supply` | commands, `cli.mjs` |
| Claim supply (`src/supply/`) | `src/util`, `src/evidence` | the probe orchestrator, commands, `cli.mjs` |
| `src/probe/runners/` | `src/util`, `src/scratch-dir.mjs`, `shared.mjs`, the pure helpers in `src/probe/` | the probe orchestrator |
| `spec/lib/` | nothing in `src/` | all of `src/` |

`spec/` is the bottom of the graph on purpose. It is a contract shared with
other tools, and it must remain portable out of this repository.

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js >= 20, ESM | `node:util.parseArgs` is the floor; the first target runners are JavaScript |
| Runtime dependencies | exactly one, `ajv` 8.20.0, exact-pinned | Every document is validated before it is written; everything else is standard library |
| Test runner (ours) | vitest | Also our first supported runner, so we dogfood it |
| Supported runners | vitest, jest, explicit node-test (project runners); Playwright and Python (per file; Python also as the project runner) | Native Node uses authenticated entry receipts and a bounded structured reporter, reusing shared process budgets. Eligible single-entry confirmations use one fresh process; discovery and multiple entries retain isolated controller/workers. Auto selection does not infer Node eligibility from its availability |
| Schemas | JSON Schema 2020-12 | Readable without the tool; portable to other languages |
| Distribution | npm, PyPI, Homebrew, GitHub Action, pre-commit, GitLab component | Meet teams in the pipeline they already run |
| Publishing | OIDC for npm/PyPI; tap-scoped SSH deploy key for Homebrew | Registry credentials remain tokenless; the only stored publishing secret cannot access any repository except the tap |

## Configuration Files

<!-- docguard:section id=configuration-files source=human covers=".github/scripts/check-cost-budget.mjs, packaging/gitlab/testguard.gitlab-ci.yml, packaging/homebrew/testguard.rb" -->
Every configuration file in the repository, and what it governs. A file that
appears here but not on disk, or on disk but not here, is drift.

| File | Governs | Consumed by |
|---|---|---|
| `package.json` | Version (single source of truth), bin, files, scripts, the one runtime dependency | npm, the release pipeline |
| `pyproject.toml` | The PyPI wrapper's metadata; version synced from `package.json` | PyPI |
| `vitest.config.mjs` | Our own test run; excludes `fixtures/`, which contain a deliberately flaky suite driven by the tool's tests, and `corpus/` and `.claude/` | vitest |
| `.pre-commit-config.yaml` | Local hooks **for contributors to this repository**: DocGuard guard, claims validation, the change gate, and the probe on pre-push | the pre-commit framework, opt-in per clone |
| `.pre-commit-hooks.yaml` | Hook definitions **we publish for consumers** of TestGuard — a different file for a different audience | consumers' `.pre-commit-config.yaml` |
| `action.yml` | The GitHub Action surface; `version` input synced from `package.json` | consumers' workflows |
| `packaging/gitlab/testguard.gitlab-ci.yml` | The GitLab component; tag and `TESTGUARD_VERSION` synced | consumers' pipelines |
| `packaging/homebrew/testguard.rb` | The staged Homebrew formula; tarball URL and registry-derived hash synced, then copied byte-for-byte | `raccioly/homebrew-tap` |
| `testguard.concerns.json` | The one-sentence scopes a sweep can be aimed by; optional, with two built-ins behind it | `testguard concerns`, `sweep --concern` |
| `testguard.claims.json` | This repository's own claims; the self-probe verifies them | `testguard probe .`, CI |
| `testguard.ignore.json` | Paths and removed claims excused from the gates, each with a reason | `testguard gate`, `testguard claims --since` |
| `testguard.cost-budget.json` | The self-probe's cost ceiling, in normalized seconds, and its shard plan | `.github/scripts/check-cost-budget.mjs`, `shard-probe.mjs`, CI |
| `.docguard-doc-reviews.json` | The record `docguard review --accept` writes: the commit and file fingerprints of each reviewed document | DocGuard (`docguard review`) |
| `.docguard.json`, `.docguardignore` | Which canonical documents exist and which validators run | DocGuard, in CI and pre-commit |
| `.npmrc`, `.npmignore`, `.gitattributes` | Packaging and line-ending hygiene | npm, git |
<!-- /docguard:section -->

## External Dependencies

TestGuard contacts no network service. It has no telemetry, no update check
and no license server.

| Dependency | Purpose | Availability impact | Failure mode |
|---|---|---|---|
| `ajv` (npm, bundled) | Validate every document against the spec | none — local | Install-time only; the install smoke gate catches a missing runtime dep |
| `git` (system binary) | Worktree isolation, diffs, snapshots, patch ids | none — local | Precondition failure with a stated reason, exit 2 |
| The project's test runner | Runs the defenders | none — local | Precondition failure, exit 2; never a verdict about a claim |
| npm / PyPI registries and Homebrew tap | Distribution only | build time | A publish fails; the tool itself never calls them at run time |

## Infrastructure (IaC)

Not applicable. TestGuard is a command-line tool distributed as packages. It
provisions nothing, has no servers, no database and no cloud account. The only
hosted component is GitHub Actions, defined in `.github/workflows/`.

### Deployment Pipeline

Releases are tag-driven and idempotent. `package.json` is the single source of
truth for the version; `.github/scripts/sync-release-version.mjs` propagates it
to every other surface and `--check` fails the build on drift.

| Stage | Where | Gate |
|---|---|---|
| Pull request | `ci.yml` | Suite on Node 20/22/24 in three shards, syntax check of every source, install-from-tarball smoke, Python wrapper import, MCP handshake, DocGuard, fixture oracles for vitest, jest, native Node (also on the Node 20.0.0 floor) and Python, Playwright job, hermeticity run under a hostile global git config, change gate, removed-claim check, anchor/replacement preflight before self-probe, self-probe of the claims the change can affect |
| Release gate | `ci.yml` | TestGuard probes all of its own claims, in shards, on pushes to main, the nightly run, release branches and any pull request that can alter every verdict; every fault must be killed, and the cost stays inside `testguard.cost-budget.json` |
| Release pull request | `scheduled-release.yml`, `ci.yml` | Weekly, when anything releasable merged since the last tag: version bump, changelog entry and synced surfaces. Its CI probes the tree in full once and stores the evidence under the tree hash |
| Merge to main | `release.yml` | A version with no tag is tagged once the release pull request's evidence is verified to describe this exact tree, released, and published to npm and PyPI over OIDC; the verified formula is pushed to the live Homebrew tap with its repository-scoped deploy key, and its registry-derived hash lands on main as a bot pull request |
| Recovery | `release.yml` | Hourly sweep; each registry and the formula hash are gated on their own state, so a partial publish is fixed by re-running |

## Diagrams

```
                    testguard.claims.json          (what must be true)
                              │
               claims --check-anchors
            (exact anchors + syntax, no tests)
                              │
                              ▼
   ┌─────────── probe ────────────────────────────────────────────┐
   │  scratch git worktree  ←── isolation, never your tree        │
   │        │                                                     │
   │        ├─ baseline: run defenders N times unmodified         │
   │        │     └─ not green N/N ──────────────► FLAKY-DEFENDER │
   │        ├─ inject fault (anchor must hit exactly)             │
   │        │     └─ anchor missing/ambiguous ────► UNVERIFIABLE  │
   │        ├─ probe: run defenders N times                       │
   │        │     ├─ all fail ────────────────────► killed        │
   │        │     ├─ all pass ────────────────────► SURVIVED      │
   │        │     ├─ did not compile or load ─────► FAULT-INVALID │
   │        │     ├─ timed out ───────────────────► TIMEOUT       │
   │        │     └─ disagreed ───────────────────► FLAKY-DEFENDER│
   │        │     └─ threw ───────────────────────► UNVERIFIABLE  │
   │        │            (probe-error; the run continues)         │
   │        ├─ on a survivor: negative control — make the subject │
   │        │  unparseable and rerun the defenders once           │
   │        │     └─ still green ─────────────────► UNVERIFIABLE  │
   │        │            (subject-not-executed)                   │
   │        ├─ escalate survivors against the whole suite         │
   │        └─ restore (a scratch target already gone is recorded)│
   └──────────────────────────┬───────────────────────────────────┘
                              ▼
                     .testguard/evidence.json
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          baseline         status           brief
        (freeze debt)   (one next action)  (tell the agent)
```

Per-file runner selection: a defender under Playwright's `testDir` runs under
Playwright whatever the project runner is. Runs from several runners merge
pessimistically — any load error is an error, any timeout is a timeout, any
failure is a failure.

## Revision History

| Version | Date | Change | Author |
|---|---|---|---|
| 1.0.0 | 2026-09-18 | First canonical architecture, written against v0.6.0 | @raccioly |
