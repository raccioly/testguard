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
applies each fault in an isolated copy of the repository, runs the tests the
claim names as its defenders, and reports every fault the tests failed to
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

| Component | Responsibility | Entry point |
|---|---|---|
| CLI dispatch | Parse argv, select a command, map errors to exit codes | `src/cli.mjs`, `cli/testguard.mjs` |
| Commands | Thin wrappers: read flags, call a module, render output | `src/commands/*.mjs` |
| Claims | Load and validate the claims file; reconcile `@claim` annotations; detect removed claims; preflight exact anchors and supported replacement syntax | `src/claims/` |
| Probe engine | Isolate, inject, run, escalate, restore, classify, rank | `src/probe/probe.mjs` |
| Verdict function | The pure decision: runs in, verdict out | `src/probe/classify.mjs` |
| Injector | Apply and restore a fault; anchor location | `src/probe/inject.mjs` |
| Isolation | Scratch git worktree, or in-place with restore guarantees | `src/probe/worktree.mjs` |
| Runners | One module per test runner behind a single interface | `src/probe/runners/` |
| Discovery | Which tests defend a target, and which merely mock it | `src/probe/discover.mjs`, `src/probe/mocks.mjs` |
| Ranking | Severity, claim provenance and blast radius; alias resolution | `src/probe/rank.mjs` |
| Contention | Detect competing test runners; record them on the evidence | `src/probe/contention.mjs` |
| Independence | Record, per kill, whether an unrelated test also failed | `src/probe/independence.mjs` |
| Attribution | Escalation's killer intersection, flake rate, the subject record — pure | `src/probe/attribution.mjs` |
| Cost | What a probe spent, per claim and per defender file, derived from evidence | `src/probe/cost.mjs` |
| Progress | How a running probe reports itself, per reader: tty, plain, ndjson | `src/probe/progress.mjs` |
| Change gate | Claim coverage of a diff | `src/gate/changed.mjs` |
| Baseline | Freeze debt; gate the delta; re-stamp | `src/baseline/baseline.mjs` |
| Status | The single state machine every rendering derives from | `src/status/status.mjs` |
| Brief | The agent's session-start blind-spot block | `src/brief/brief.mjs` |
| Admit | The two-gate acceptance rule as one verb | `src/admit/admit.mjs` |
| Replay | Would this suite have caught the bugs that already escaped? | `src/replay/` |
| Scaffold | Mechanical fault producers, deterministic, no AST and no LLM | `src/scaffold/producers.mjs` |
| Install layer | Writes the agent layer: skill, session-start hook, `AGENTS.md` section, gitignore lines | `src/init/` |
| MCP server | The operating loop over stdio, read-only | `src/mcp/` |
| Spec | The shared contract: schemas, validator, fingerprint | `spec/` |

## Layer Boundaries

Dependencies point downward only. A layer may call the layers below it and
never the layers above.

| Layer | May call | Must not call |
|---|---|---|
| `cli.mjs` | commands | engine modules directly |
| `src/commands/` | engine modules, `spec/lib` | other commands |
| Engine (`probe`, `gate`, `baseline`, `status`, `brief`, `admit`, `replay`) | `spec/lib`, `src/util`, `src/git.mjs`, runners | commands, `cli.mjs` |
| `src/probe/runners/` | `src/util`, `shared.mjs` | the probe orchestrator |
| `spec/lib/` | nothing in `src/` | all of `src/` |

`spec/` is the bottom of the graph on purpose: it is a contract shared with
other tools, and it must remain portable out of this repository.

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js >= 20, ESM | `node:util.parseArgs` is the floor; the first target runners are JavaScript |
| Runtime dependencies | exactly one, `ajv` 8.20.0, exact-pinned | Every document is validated before it is written; everything else is standard library |
| Test runner (ours) | vitest | Also our first supported runner, so we dogfood it |
| Supported runners | vitest, jest (project runners); Playwright (per file) | They share a JSON report shape; Playwright is selected per file, not per project |
| Schemas | JSON Schema 2020-12 | Readable without the tool; portable to other languages |
| Distribution | npm, PyPI, Homebrew, GitHub Action, pre-commit, GitLab component | Meet teams in the pipeline they already run |
| Publishing | OIDC Trusted Publishing | No long-lived tokens exist to leak or rotate |

## Configuration Files

Every configuration file in the repository, and what it governs. A file that
appears here but not on disk, or on disk but not here, is drift.

| File | Governs | Consumed by |
|---|---|---|
| `package.json` | Version (single source of truth), bin, files, scripts, the one runtime dependency | npm, the release pipeline |
| `pyproject.toml` | The PyPI wrapper's metadata; version synced from `package.json` | PyPI |
| `vitest.config.mjs` | Our own test run; excludes `fixtures/`, which contain a deliberately flaky suite driven by the tool's tests | vitest |
| `.pre-commit-config.yaml` | Local hooks **for contributors to this repository**: DocGuard guard, claims validation, the change gate, and the probe on pre-push | the pre-commit framework, opt-in per clone |
| `.pre-commit-hooks.yaml` | Hook definitions **we publish for consumers** of TestGuard — a different file for a different audience | consumers' `.pre-commit-config.yaml` |
| `action.yml` | The GitHub Action surface; `version` input synced from `package.json` | consumers' workflows |
| `packaging/gitlab/testguard.gitlab-ci.yml` | The GitLab component; tag and `TESTGUARD_VERSION` synced | consumers' pipelines |
| `packaging/homebrew/testguard.rb` | The Homebrew formula; tarball URL synced | `raccioly/homebrew-tap` |
| `.docguard.json`, `.docguardignore` | Which canonical documents exist and which validators run | DocGuard, in CI and pre-commit |
| `.npmrc`, `.npmignore`, `.gitattributes` | Packaging and line-ending hygiene | npm, git |

## External Dependencies

TestGuard contacts no network service. It has no telemetry, no update check
and no license server.

| Dependency | Purpose | Availability impact | Failure mode |
|---|---|---|---|
| `ajv` (npm, bundled) | Validate every document against the spec | none — local | Install-time only; the install smoke gate catches a missing runtime dep |
| `git` (system binary) | Worktree isolation, diffs, snapshots, patch ids | none — local | Precondition failure with a stated reason, exit 2 |
| The project's test runner | Runs the defenders | none — local | Precondition failure, exit 2; never a verdict about a claim |
| npm / PyPI registries | Distribution only | build time | A publish fails; the tool itself never calls them at run time |

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
| Pull request | `ci.yml` | Suite on Node 20/22/24, syntax check of every source, install-from-tarball smoke, Python wrapper import, fixture oracles for vitest and jest, Playwright job, change gate, removed-claim check, anchor/replacement preflight before self-probe |
| Release gate | `ci.yml` | TestGuard probes its own claims; every fault must be killed |
| Merge to main | `release.yml` | A version with no tag is tagged, released, and published to npm and PyPI over OIDC |
| Recovery | `release.yml` | Hourly sweep; each registry is gated on its own state, so a partial publish is fixed by re-running |

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
   │        │     ├─ all fail by assertion ───────► killed        │
   │        │     ├─ all pass ────────────────────► SURVIVED      │
   │        │     ├─ timed out ───────────────────► TIMEOUT       │
   │        │     └─ disagreed ───────────────────► FLAKY-DEFENDER│
   │        │     └─ threw ───────────────────────► UNVERIFIABLE  │
   │        │            (probe-error; the run continues)         │
   │        ├─ on a survivor: negative control — make the subject │
   │        │  unparseable and rerun the defenders once           │
   │        │     └─ still green ───────────────────► UNVERIFIABLE │
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
