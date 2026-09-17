# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-09-17

From a field report on a real codebase (63 test files, 458 tests, 39 faults).

### Fixed

- **A runner that cannot be resolved was reported as `FLAKY-DEFENDER`.** In
  the scratch worktree, a symlinked `node_modules` (the sibling/auto-worktree
  layout) was invisible, vitest failed to load, and the load error was
  classified as flaky tests — blaming the wrong party. Symlinked
  `node_modules` are now linked to their resolved target; the runner is
  checked before any verdict and an unresolvable one is a precondition
  failure (exit 2) with the fix in the message; defenders that fail to
  *load* during a baseline are `UNVERIFIABLE` (`defenders-failed-to-load`),
  never flaky.
- **Blast radius ignored path aliases.** `tsconfig`/`jsconfig` `paths` (with
  `baseUrl` and relative `extends`) and `package.json#imports` are resolved,
  so a module imported 83 times via `@/…` no longer ranks as if nothing
  imported it. Bare package specifiers remain ignored, as documented.
- Summary said "N unproven claims" when N counted faults; it now reports
  unproven faults *and* the distinct claims they belong to.
- `testguard claims` never showed which claims carry a `@claim` annotation;
  it now reports the count and marks each annotated row.
- Piping output to a closed reader (`testguard claims | head`) no longer
  crashes with an `EPIPE` stack trace.

### Added

- `--claim <ID,ID>` probes only the named claims and writes
  `.testguard/evidence-partial.json`, keeping the canonical evidence intact —
  turns a fix-loop iteration from minutes into seconds.
- `--runner-cmd "<cmd>"` with `{files}` and `{out}` placeholders for
  monorepos, custom configs and other package managers.
- `--node-modules <dir>` (or `TESTGUARD_NODE_MODULES`) to link a specific
  `node_modules` into the scratch worktree.

### Changed

- The `--in-place` precondition message says what it means: only fault
  target files must be clean; test files may be dirty.
- `testguard baseline` prints the two `.gitignore` lines for the regenerated
  files instead of leaving it to the README.
- With no baseline, the ranked block is not printed a second time under the
  per-fault stream.
- `--quiet` is documented precisely.
- Staged Homebrew formula carries the sha256 of the published 0.1.1 tarball.

## [0.1.1] - 2026-09-17

### Fixed

- **0.1.0 did not run when installed.** `ajv`, which validates every document
  against the spec, was declared as a devDependency, so `testguard` crashed on
  startup from npm, `npx`, `pip` and Homebrew. It is now an exact-pinned
  runtime dependency — the project's one dependency.
- CI and the release job now pack the tarball, install it into a scratch
  project with production dependencies only, and run the CLI from there
  (`npm run test:install`). The suite alone runs from the checkout and could
  not see this class of defect.

### Changed

- Homebrew formula carries the sha256 of the published tarball; description
  shortened to satisfy `brew audit --strict`.

## [0.1.0] - 2026-09-17

First release. A claim verifier, not a test generator.

### Added

- **Contract spine** (`spec/`): six shared JSON Schemas — claims, evidence,
  baseline, ignore, calibration, brief — identified as `urn:guard-spec:v1:*`,
  with a validator that enforces the semantic rules a schema cannot express,
  a single fingerprint derivation, `GATE-SEMANTICS.md`, and a conformance
  corpus (one valid document per kind, 22 must-reject documents).
- **`testguard claims`** — validates the claims file and reports drift
  against `@claim <ID>` annotations in source.
- **`testguard probe`** — applies each fault in a scratch git worktree,
  confirms the defenders green N times, runs them N times with the fault,
  escalates survivors to the whole suite with N-run attribution, restores,
  classifies into a closed verdict set (`killed`, `survived`, `nocover`,
  `unverifiable`, `timeout`, `fault-invalid`, `flaky-defender`), ranks, and
  writes evidence validated against the spec. `--ref` pins the probed commit.
  Verdicts are reused when the target, defenders and N are unchanged.
- **`testguard baseline`** — freezes every non-passing fingerprint so only
  new findings gate; severity floor via `--severity`.
- **`testguard brief`** — a ranked, capped `## TEST BLINDSPOT CONTEXT` block
  for an agent's session start; `--text` is hook-safe.
- **Known-answer fixture** with a genuine `objectContaining` blind spot and a
  case for every verdict; probed end to end in the test suite and in CI.
- **Self-verification**: `testguard.claims.json` states invariants of the
  tool itself, probed by the tool in CI.
- Distribution: npm (`testguard-cli`), PyPI wrapper (`testguard-cli`),
  GitHub Action, Homebrew formula (staged), pre-commit hooks.
