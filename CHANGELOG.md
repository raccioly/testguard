# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The session-start hook now contains no form of `npx`.** It fell back to
  `npx --no-install`, and `--no-install` is quiet rather than offline:
  measured, `npx --no-install --loglevel=http testguard-cli --version` in a
  project with nothing installed logs
  `npm http fetch GET 200 https://registry.npmjs.org/testguard-cli`, and
  against an unreachable registry it exits non-zero. npm resolves the
  packument before deciding not to install. The fallback is now a
  `command -v` lookup, which covers a global install with no network at all.
  `TG-INIT-HOOK-NO-NETWORK` was defended while its statement over-promised;
  the statement and its fault are corrected together.
- The PATH branch is braced. `a || b && c` binds as `(a || b) && c` in sh, so
  the unbraced form printed the brief **twice** whenever the local binary
  succeeded. The tests now execute the hook in all three cases (local, PATH,
  neither) rather than matching its text.
- `init` recognises an earlier `npx --no-install` hook as well as `npx -y`,
  and its which-project check no longer mistakes `brief --text 2>/dev/null`
  for a hook belonging to a directory — that misfire meant a legacy root hook
  was never replaced.

### Added

- **`testguard mcp`** — the operating loop, served over the Model Context
  Protocol on stdio, so it survives a change of agent harness. The loop has
  lived in a Claude Code skill and a session-start hook, and both vanish the
  moment the harness is Cursor, Codex or whatever comes next. Five tools,
  all **read-only**: `testguard_status`, `testguard_brief`,
  `testguard_claims`, `testguard_evidence` and `testguard_next_command`.
  **No tool runs a probe** — a probe is long-running, budgeted and the
  person should see it happen, so `next_command` returns the shell line
  instead; and no tool writes a file, because editing a claims file through
  a connector would defeat recording every fault edit. The server declares
  only a `tools` capability, and a tool that throws returns an `isError`
  tool result rather than a protocol error, so one bad call never costs the
  connection.
  Hand-written against a pinned protocol version rather than built on the
  official SDK: this tool keeps its single exact-pinned runtime dependency,
  and the surface is three methods that will not grow. The tests speak the
  wire format to a real child process and check every tool against the CLI's
  own `--json` output, so the two cannot drift.
  `init --mcp` prints the config for Claude Code, Cursor and Codex — printed,
  never written, because a harness config is the person's file. Self-claims
  `TG-MCP-IS-READ-ONLY` and
  `TG-MCP-TOOL-FAILURE-IS-NOT-A-PROTOCOL-ERROR`. (#30)

### Fixed

- **`replay` scopes to the project directory.** In a monorepo a fix commit
  routinely touches several packages; the harness kept the out-of-project
  files in the revert, so every cross-package fix came back
  `revert-did-not-apply` — a tooling failure wearing the costume of a
  verdict. Found on a real corpus, where it was two of the first three
  commits. A commit with no source-and-test pair inside the project is no
  longer a candidate at all. Self-claim `TG-REPLAY-SCOPES-TO-THE-PROJECT`.
- **`replay` reverts a file the fix ADDED by removing it**, and calls a commit
  whose source is entirely new `no-prior-version` rather than a failed revert.
  A fix routinely adds a helper as well as changing a module, and a file that
  did not exist at the parent cannot be checked out of it: on a real corpus
  this turned **nineteen of forty** commits into `revert-did-not-apply` — a
  tooling failure reading as a verdict and hiding every real result behind it.
  An addition is not a bug the suite could have caught, so it never enters a
  calibration. Self-claim
  `TG-REPLAY-ADDED-FILE-IS-REMOVED-NOT-CHECKED-OUT`.
- `replay --out <path>` now writes the calibration beside it rather than into
  the project's `.testguard/`: the two documents are one result and splitting
  them loses the pairing.

### Added



- **Contention detection and `--serial`** (#26). `probe` looks for other test
  runners before the first run, warns naming their pids, and records them on
  the evidence (`run.contention`) — a contended machine turns a slow suite
  into a `TIMEOUT` or `FLAKY-DEFENDER` verdict about the load, not the claim,
  and a later reader of that verdict can now tell. `--serial` runs one test
  file at a time (`--no-file-parallelism`, `--runInBand`, `--workers=1`) and
  is recorded as `run.serial`. Best effort by design: an unreadable process
  list is no detection and never fails a probe.

- **`claims --since <ref>`** — a claim that disappeared was invisible to every
  other check: `probe` verifies what is there, `gate` sees the file covered by
  another claim, `status` says clean. Since deleting a claim is cheaper than
  weakening its fault (which `changedFaults` already surfaces), removal is now
  reported: `removed-claim` and `removed-fault` gate, a rename that keeps the
  statement verbatim is `renamed-claim` and does not, and where evidence exists
  the finding names the verdict the claim last had. Excused by a `claim` entry
  in `testguard.ignore.json` with a reason, with expiry honoured as everywhere
  else. This repository's CI runs it on its own pull requests. Found the hard
  way: a `--theirs` conflict resolution dropped two self-claims during this
  release and nothing noticed. Self-claim `TG-REMOVED-CLAIM-IS-A-FINDING`. (#57)

- **`testguard replay --since <range>`** — would this suite have caught the
  bugs that already escaped? For each fix commit in the range (one that
  changes source *and* a test together), it reverts only the source to the
  parent in a scratch worktree, removes the test the fix shipped, and runs the
  tests that import the reverted code: `caught`, `blind`, `nocover`, `flaky`
  or `unverifiable`. One patch counts once (`git patch-id`). It reports and
  never gates — a bug that escaped is history, not a regression in this
  change. An injected fault is one somebody thought of; a bug that shipped is
  ground truth, with no equivalent-mutant argument to have about it.
- **Fault-class labelling and the first calibration.** Each replayed bug is
  labelled with the injected-fault class its diff most resembles — the
  scaffold producers read in reverse, deterministic, `other` rather than a
  guess — and a `calibration` document is written beside the replay one:
  per class, the share of real escaped bugs the suite missed, with a Wilson
  interval and n. Only `caught` and `blind` carry information; the rest are
  excluded from both sides. `calibration.schema.json` has had no producer
  until now. The open question it exists to answer — does a calibration
  learned on a repository with history transfer to a greenfield one — stays
  open; this is the instrument, not the answer. (#35)
- New spec kind **`replay`** (`replay.schema.json`), with semantic rules:
  `caught` needs every run to fail by assertion, `blind` needs every run to
  pass, `flaky` needs runs that disagree, `nocover` cannot have run tests,
  and a duplicate patch-id is rejected. Conformance example plus two
  must-reject documents. Self-claims
  `TG-REPLAY-FLAKY-IS-NEVER-CAUGHT`, `TG-REPLAY-DEDUPES-BY-PATCH`,
  `TG-CALIBRATION-EXCLUDES-UNINFORMATIVE` and `TG-LABEL-NEVER-GUESSES`.







- **`baseline --restamp`** (#25). A baseline frozen from `--include-dirty`
  evidence now records the snapshot commit and, once you commit, a clean
  `probe` plus `--restamp` moves its `head` to that commit — only when the
  fingerprints are identical and the tree is clean; a frozen contract is
  never silently rewritten. `status` gains informational `notes` (never a
  state): a baseline frozen from a snapshot or a dirty tree that predates
  HEAD, or one whose head is not an ancestor of HEAD.


- **Mock-aware defender discovery** (#20). A test file that `vi.mock`s /
  `jest.mock`s the target cannot detect any fault in it and is no longer a
  discovered defender; `NOCOVER` now means "no test imports this source
  without mocking it". The evidence lists such files under
  `defenders.mocking` (a *declared* defender that mocks the subject stays,
  and is listed, as a broken evidence chain); `claims` prints the split
  (`18 import · 16 mock · 2 can detect`).
- **`mocked-never-asserted`** (#21): a static signal for a test that mocks
  the target and never `expect(...)`s anything imported from it — the exact
  signature of an escaped bug in a field report. Recorded on the evidence
  (`defenders.signals`), printed by `claims`, carried into the brief's hints.
  `// unasserted: <why>` above the mock silences it visibly
  (`unasserted-annotated` with the reason).
- Alias resolution follows tsconfig `references` (the Vite layout, where
  `paths` live in `tsconfig.app.json`) and reads vite/vitest `resolve.alias`
  as text, so importers from nested `__tests__/` directories are found.
- Both known-answer fixtures gain a claim whose only importing test mocks
  the module: expected `NOCOVER`, with the mocking file and the signal
  recorded.

- **`testguard admit <test-file> --claim <ID>`** — the two-gate rule as a
  named verb. Sugar over `probe --claim <ID> --include-dirty --no-escalate`:
  the named test must be a declared or discovered defender of the claim
  (exit `3` otherwise, with the `defendedBy` line to add); `ADMITTED`
  (exit `0`) only when every fault of the claim is `killed` N/N on defenders
  that were green N/N unmodified; anything else is `NOT ADMITTED` (exit `1`)
  and names the first blocking fault with the hint the brief would give.
  `--fault <FID>` judges one fault, `--confirm 1` gives a provisional
  `ADMITTED?`, `--json` returns `{admitted, provisional, faults[], evidence,
  command}`. Evidence goes to `.testguard/evidence-partial.json`; nothing new
  in the evidence schema. The market's acceptance signal for a generated
  test is "compiles, passes, raises coverage"; this one is "fails when the
  claim is false", and it is now one command. `status.next` for `unproven`
  and the installed skill's fix loop point at it. Self-claim
  `TG-ADMIT-NEEDS-ALL-KILLED`.

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








- `probe` honours an explicit `--ref` (even `--ref HEAD`) when defender or
  target files are dirty, and gains `--ignore-dirty` for the implicit HEAD
  (#19). Both warn with the file names and record them in the evidence as
  `repo.ignoredDirty` (spec: new optional field; a snapshot run can never
  carry it). The refusal stays for the implicit HEAD without the flag — that
  is the silent-mismatch trap the check exists for.

- CI: TestGuard's self-probe runs on one Node leg instead of three, without
  escalation, and restores the previous run's evidence from the cache so
  unchanged claims reuse their verdicts. The verdicts do not depend on the
  Node minor; the from-scratch probe was ~14 minutes per leg.

## [0.5.0] - 2026-09-17

The change gate: unclaimed code is now a finding.

### Added

- **Playwright runner, selected per file** (#15). A defender under
  `playwright.config.*`'s `testDir` runs under Playwright whatever the
  project runner is; one claim may list a unit test and a browser spec, and
  the evidence records `defenders.byRunner` and `run.runners`. Playwright's
  statuses map onto the verdict rules: `timedOut` is a timeout, never a
  kill; `flaky` (failed, passed on retry) is a non-green run, so a defender
  that only passes on retry is `FLAKY-DEFENDER` even though Playwright exits
  0. Runs from several runners merge pessimistically. `--runner playwright`
  selects it for a whole project. A browserless mixed fixture
  (`fixtures/known-answer-playwright`, with its own dependencies) is the
  oracle, verified by hand; a dedicated CI job runs it.
- **Two UI `scaffold` shapes**: `element-removed` (a one-line JSX element,
  self-closing or paired) and `handler-dropped` (an `on<Event>={…}` prop, on
  its own line or inline). Never inside tests, fixtures or migrations.

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
