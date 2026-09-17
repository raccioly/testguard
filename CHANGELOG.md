# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`init` installs the agent layer at the git root** (#23): the skill,
  the session-start hook and the `AGENTS.md` section go where agent
  sessions run; the `.gitignore` lines stay beside the claims file. A
  second project in the same repository adds a hook line and an
  `AGENTS.md` bullet; `--here` keeps the old placement. A written file
  that `.gitignore` swallows is reported (exit 1), never offered for
  commit.
- **The session-start hook never fetches from the network** (#24):
  `node_modules/.bin/testguard … || npx --no-install testguard … || true`
  instead of `npx -y testguard-cli …`; a pre-0.6 hook is replaced on the
  next `init`. The brief's first line names the install that answered.
- CI: TestGuard's self-probe runs on one Node leg instead of three, without
  escalation, and restores the previous run's evidence from the cache so
  unchanged claims reuse their verdicts. The verdicts do not depend on the
  Node minor; the from-scratch probe was ~14 minutes per leg.

## [0.5.0] - 2026-09-17

The change gate: unclaimed code is now a finding.

### Added

- **Two `scaffold` shapes and two fault classes.** `field-dropped` (#14):
  a field removed from an object that is returned, built by an arrow,
  assigned to a payload-ish name, passed to a persistence/transport call,
  or is a schema; an entry removed from an allow-list; a spread base dropped
  from a merge. Only lines that can go on their own; never inside tests,
  fixtures or migrations. `argument-swapped` (#22): a call kept with its
  parameter-derived first argument swapped for `undefined` (and `{}` when
  the argument is a call) — the seam fault a field report found behind an
  escaped bug that no earlier shape could express. The known-answer fixture
  gains one of each, verified by hand: the dropped `content` field
  **survives** (the same `objectContaining` blind spot as the exhibit), the
  swapped argument is killed.

- **`testguard gate --changed <ref>`** — the change gate. Every escaped
  defect in the field reports was a *claim gap*: the feature shipped green
  with zero claims, and `probe` is silent about unclaimed code by
  construction. `gate` measures the files changed since
  `merge-base(ref, HEAD)` (or in the working tree with `--include-dirty`)
  and exits `1` when any changed source file carries no fault, does not
  resolve as a defender (test files), and is not excused by an unexpired
  `path` entry in `testguard.ignore.json`. Every reliance on an ignore entry
  is printed with its reason; expired entries excuse nothing. Non-source
  files and documented never-claimed patterns are excluded and listed
  (`--explain`, `--exclude <glob>`); `--strict` fails a change that
  evaluated nothing. The base branch is detected in GitHub Actions and
  GitLab CI (`TESTGUARD_CHANGED_REF` overrides). A new spec kind,
  `gate.schema.json`, with conformance examples.
- **`status --changed <ref>`** — a new state `unclaimed-changes` and action
  `claim` that precede every evidence state; `next.file` names the first
  unclaimed file. `brief` renders unclaimed files before the findings, and
  briefs them even when there is no evidence yet.
- `testguard.ignore.json` at the repository root: TestGuard's own excused
  paths (dispatch, thin command wrappers, rendering), with reasons.
- Nine new self-claims: the gate, status and brief invariants, explicit
  `--changed` being required, `init` idempotency, and — because the gate
  flagged it on its own pull request — the release version-sync check,
  which had no test before. The gate runs on this repository's own pull
  requests.
- GitHub Action `command: gate` with a `changed-ref` input; pre-commit hook
  `testguard-gate`; a GitLab CI template under `packaging/gitlab/` with
  `testguard:gate` (merge request pipelines, measured against
  `CI_MERGE_REQUEST_DIFF_BASE_SHA`) and `testguard:probe`.

## [0.4.0] - 2026-09-17

### Added

- **jest runner.** `--runner vitest|jest|auto` (default `auto`: the first
  that resolves in the project). jest runs with `--ci --json --runTestsByPath`
  so file arguments are exact paths, not regexes; its `Exceeded timeout`
  wording is recognised as a timeout, never a kill; `__tests__/` files are
  collected for escalation. `run.runner.name` records which runner produced
  the evidence.
- A CommonJS edition of the known-answer fixture (`fixtures/known-answer-jest`)
  with the same claims and the same expected verdicts; the acceptance suite
  and CI prove jest against it exactly as vitest is proven against the ESM
  one.

### Changed

- Runners are now modules behind one interface (`src/probe/runners/`); the
  vitest path is unchanged and still reproduces its oracle.

## [0.3.1] - 2026-09-17

Dogfooding `init` and `status` on this repository.

### Fixed

- `init` no longer adds per-file `.gitignore` lines to a project that already
  ignores `.testguard/` wholesale; it notes instead that `baseline.json` is
  meant to be committed.
- The brief no longer says "everything is new" when nothing is unproven.

### Changed

- This repository now carries its own `AGENTS.md` TestGuard section, written
  by `testguard init`.

## [0.3.0] - 2026-09-17

The agent operating layer. TestGuard is meant to be run by AI agents; this
release gives them one source of truth, an installable loop, and makes the
one cheap way to game it visible.

### Added

- **`testguard status --json`** — the machine entry point. A new spec kind
  (`status.schema.json`): `state` (no-claims · unprobed · evidence-stale ·
  provisional-only · unproven · clean) and the one `next` action, computed
  from claims, evidence, baseline and the working tree. Exit 0 clean, 1
  unproven/stale, 2 nothing to probe yet.
- **`testguard init`** — installs `.claude/skills/testguard/SKILL.md`, the
  `brief --text` SessionStart hook (merged into an existing
  `.claude/settings.json`), an `AGENTS.md` section and the `.gitignore`
  lines. Idempotent; `--force` replaces the skill.
- **Fault edits are visible.** Evidence records `subject.contentHash`;
  `status` lists `changedFaults` (a fault edited after it was probed, with
  its previous verdict) and makes `review-fault-change` the next action when
  the edited fault had survived. Gate rule 8. Self-claim
  `TG-FAULT-EDIT-VISIBLE`.
- `--json` on every command; `probe` and `baseline` emit the status document
  plus their result. `brief` carries `next` and prints it.

## [0.2.1] - 2026-09-17

### Added

- **Provisional verdicts** (#5). A run with `--confirm` below 3 declares
  `run.provisional: true` — a spec field whose equivalence with
  `confirmRuns < 3` the validator enforces both ways. Provisional verdicts
  print with a `?`, the summary is prefixed `PROVISIONAL`, a warning is
  printed on stderr, evidence is written to `.testguard/evidence-provisional.json`
  so the canonical file only ever holds confirmed runs, `brief` warns at the
  top, and `baseline` refuses provisional evidence unless
  `--allow-provisional`. A confirmed prior verdict is never reused by a
  provisional run, nor the reverse.

## [0.2.0] - 2026-09-17

### Added

- **`testguard scaffold <file>`** — mechanical fault producer (#6). Proposes
  the five shapes both field reports found behind ~80% of hand-written
  faults: guard forced false, single-line guard or state change removed,
  `return <check>` → `return true`, security literal weakened, check call
  removed. Every proposal is an exact-line anchor with `expectHits` and
  `occurrence` computed from the file (verifiable by construction; anything
  `locate()` would reject is never emitted), `producedBy: derived`,
  `defendedBy` prefilled from the tests that import the module, grouped
  under a preceding `@claim` annotation or by enclosing function.
  Statements are `TODO:` placeholders; the output is a draft under
  `.testguard/`, never the claims file. `--claim <ID>` puts everything under
  one claim and copies it if it exists; `--json` prints instead.
- Self-claim `TG-SCAFFOLD-ANCHORS-HIT`; install smoke exercises `scaffold`.

## [0.1.3] - 2026-09-17

From a second field report on a real codebase (456 tests, 27 claims, 35
faults; 13 survived on the first run, two critical claims with zero coverage).

### Fixed

- **Worktree mode probed HEAD while reading the claims file from the working
  tree**, so uncommitted defender changes were silently ignored — the same
  survivors came back with no hint why. `probe` now refuses (exit 2) when any
  resolved defender or fault target has uncommitted changes, naming the files
  and the commit it would have probed. Every summary names the commit probed.
- `killed-by-undeclared-tests` never said which tests killed the fault; the
  author could not fix `defendedBy` without grepping the suite. Evidence now
  carries `detail.undeclaredKillers` and the CLI names the files.
- `anchor-ambiguous` did not say how many hits; `detail.anchor { hits,
  expected }` is recorded and printed.
- A replacement with an unbalanced paren was `suite-failed-to-load`, not
  `replacement-does-not-compile`: esbuild/vitest wording is now matched.
- The claims schema promised defender discovery for an absent `defendedBy`;
  the tool answered `nocover`. Discovery is implemented: the test files that
  import the fault's target (relative or alias), recorded as
  `defenders.discovered`. `nocover` now means exactly "no test file imports
  this source".
- `baseline.json` records `dirty`, as evidence already did.

### Added

- `--include-dirty`: snapshot the working tree (tracked edits and untracked,
  non-ignored files) into a throwaway commit and probe that. HEAD, index and
  the user's tree are never touched; `run.repo.snapshot` records the commit.
- A one-line progress indicator on stderr (TTY only) so a minute of silence
  is not mistaken for a hang.
- Fixture: a claim with no `defendedBy` whose defender is discovered.

### Changed

- **Default output shows only unproven faults plus a killed count.**
  `--verbose` restores the full stream.
- The `survived` hint reminds the author to check that the fault is
  observable at all before writing a test for it.
- README: `$schema` path for consumers, `min-release-age` note, the
  worktree-vs-working-tree rule, `brief` writes `brief.json` by default.

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
