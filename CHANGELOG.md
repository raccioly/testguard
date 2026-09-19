# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-09-19

Automated weekly release — everything merged since `v0.9.0`.

### Changed

- docs: the brief catches up with the tool, and stops falling behind (#112)
- chore(homebrew): sha256 for v0.9.0 (#110)
- feat(cost): two ceilings, the report where it is read, and three claims off expensive defenders (#113)
- fix(release): approve the runs GITHUB_TOKEN's own PR leaves held (#111)


### Added
- **A second cost ceiling, on the claim.** The total alone cannot see the
  failure it was meant to catch: a new calibration claim cost 51 s for two
  faults purely by being written into `replay.test.mjs` rather than
  `calibration.test.mjs`, and re-pointing it took it to 4.9 s while the total
  never moved. A per-fault average is worse — the regression that prompted
  this budget raised the fault count 59 to 91 while per-fault cost barely
  moved, so an average would have reported everything fine.

  `perClaimSeconds` is 100 s, just above today's worst claim
  (`TG-ADMIT-NEEDS-ALL-KILLED`, **87 s in CI** for one fault), so the rule
  reads: no new claim may be worse than the worst we already have. Calibrated
  against CI and not the local figure — 75 s, set from that claim's local
  66.5 s, tripped on the first CI run. This file already warns about exactly
  that for the total (950 s was 18% over local but 4.6% over CI, and the first
  PR adding a claim tripped it); the same error applies one level down. A breach names the claim
  and its remedy — a cheaper defender, not a bigger budget. The field is
  optional and additive: a budget without one behaves exactly as before.
- **The cost report goes to the CI job summary, not only the log.** The gate
  went from 9.6 to 23.6 minutes across one merged pull request and nothing
  said a word, because `--cost` only ever printed into a log nobody opens
  while it is passing. The summary is read without opening anything, so the
  number is in front of a reviewer while the change is still a change.

### Performance
- **Three claims moved off expensive shared defenders: 65 s, ~30 s and ~30 s
  down to under 2 s each.** All three faulted a *pure* function while naming
  an integration test file, and a claim pays for every test in the file it
  names. `TG-SURVIVOR-PROVES-THE-SUBJECT-RUNS` faults `classify()` but was
  defended by `negative-control.test.mjs`, which spawns real runners against
  fixture repositories; `TG-LABEL-NEVER-GUESSES` faults `labelDiff()` and
  `TG-REPLAY-FLAKY-IS-NEVER-CAUGHT` faults `classifyReplay()`, both defended
  by `replay.test.mjs`, which builds a scripted git corpus.

  Two were a straight move of an already-isolated `describe` block into
  `test/label.test.mjs` and `test/replay-verdict.test.mjs`; only the `classify`
  case needed a test written. Each was proved with `admit` — passes on HEAD and
  fails on every fault, 3/3 — *before* the expensive defender was dropped, and
  never the other way round. The integration files keep their remaining claims,
  where the fixture is the point.

### Changed
- **The cost budget is 1230 s, from 1350.** 1350 was set defensively against a
  reuse-affected 1123 s, because this budget is defined against a from-scratch
  probe and none had run yet. `release.yml` then measured **1081 s** at 129
  faults on the v0.9.0 release commit with no reuse — so the six field-report
  claims cost +82 s, not the +120 s a per-fault average predicted. 1230 is
  ~14% over 1081, the same headroom rule that set 1100 against 962. Leaving it
  at 1350 would have let a 25% regression pass unnoticed.

### Fixed
- **The release no longer waits for a human to click Approve.** v0.9.0 sat with
  every required check green and merged nothing. The `pull_request` runs a
  release PR creates are held at `action_required`, because the repository
  requires approval from first-time contributors and `github-actions[bot]` is
  permanently one — it never authors a merged commit, so it can never
  graduate. Held runs leave check suites QUEUED on the head sha, the status
  rollup never reaches a terminal state, and auto-merge waits on it even though
  `test (20/22/24)` are already green from the dispatched run.

  `scheduled-release.yml` now approves those runs itself. `GITHUB_TOKEN` is
  permitted to do this — `actions: write` carries the approve permission,
  measured 201 against a bot PR's own held run — and the workflow already held
  that permission, so nothing was granted and no secret was added. It may still
  not approve a *review*, which is a different gate and remains ours alone.
  A run left held after the poll is an `::error::` naming the run, never a
  silent wait.

  This is the third `GITHUB_TOKEN` wall in the same chain, after "raises no
  `pull_request` event" (#105) and "its push raises no `push` event" (the
  hourly sweep in release.yml). All three have the same root: an action taken
  by `GITHUB_TOKEN` does not trigger the event that would normally follow it.

### Documentation
- **The technical brief describes the tool that exists.** It was last rendered
  when it covered one verb, `probe`, and said nothing about `replay` and its
  calibration — the empirical answer to whether an injected fault resembles a
  real bug, which is the question a document arguing "evidence, not output"
  can least afford to omit. A new page covers the eleven verbs and the
  calibration, carrying the README's own framing: the greenfield transfer is
  unproven, and `replay` is the instrument rather than the answer. The verdict
  table, the cost formula and the prior-art section were checked against the
  code and left alone.
- **The brief's PDF is rendered by the release instead of by memory.** Its
  masthead read `v0.6` through three releases because nothing ever ran
  `build-one-pager.mjs`. The HTML masthead is now a version surface and
  `scheduled-release.yml` re-renders the PDF in the same step as the sync —
  the same step, because an HTML and a PDF that disagree are worse than a
  document uniformly out of date. `--require-chrome` makes a missing browser
  fail the release rather than silently commit a stale PDF, and every render
  must produce exactly one sheet per `.page` div: a section a few pixels too
  tall spills onto a second sheet with no warning from Chrome, contradicting
  the "Page N of M" footers the document prints about itself.

## [0.9.0] - 2026-09-18

Automated weekly release — everything merged since `v0.8.1`.

### Changed

- fix: the five findings from the 0.8.1 pocket-archive field report (#107)
- chore(deps): jest 30.5.1 -> 30.5.2 (#106)
- feat(release): the release PR starts its own CI (#105)
- fix(release): tag through the API when the push is refused (#104)
- chore(homebrew): sha256 for v0.8.1, from the published tarball (#103)
- fix(release): a blocked pull request says which setting blocks it (#102)


### Fixed
- **`scaffold` no longer dies on a zero-valued window literal, and proposes a
  real fault for one.** The window producer weakened a literal by ×1000, and
  ×1000 of `0` is `0` — the replacement equalled its find, which the schema
  rejects outright, so a single `expired: 0` aborted the whole file and printed
  a raw Node stack. A 725-line source was unscaffoldable for this reason. The
  same defect sat in the work-factor producer, where `rounds = 1` collapsed to
  `1`, and in both Python producers, where `timeout=0` is PEP 8 spacing and so
  the common form. The two cases are not the same, and are not fixed the same
  way: a zero window is exactly the window worth widening, so it now widens to
  a real value; a work factor already at 1 has nothing weaker to become, so it
  proposes nothing rather than proposing itself. `usableProposal()` refuses a
  no-op whatever a producer hands it, which makes the rule structural instead
  of remembered.
- **`if (…) continue;` and `if (…) break;` are guards.** Only `return` and
  `throw` were read as guard bodies, so pure selection-over-rows — the shape
  the "pure logic, caller does the IO" advice produces — got no proposals at
  all. Two fully-claimed files of seven such guards each returned nothing,
  while the hand-written faults on those same lines all killed: the shape
  `scaffold` skipped was the one demonstrably worth proposing. Both the
  single-line and the block form, in JavaScript and Python.
- **An unexpected exception is named as our bug and keeps its trace.** Four
  error classes became `error: …`; everything else reached the user as a Node
  stack trace ending in `Node.js v24.18.0`, which reads as "your repository
  broke the tool" and gives the operator nothing to do. It now says whose
  defect it is and where to report it, and still prints the trace — a framed
  error without one cannot be reported.
- **Every surface that describes the session-start hook is held to the code,
  not just the README.** 0.6.0 banned "falls back to npx" in README.md and
  added a mechanical check there. The same sentence lived in the line `init`
  prints as it installs the hook and in the `--help` entry, and both went on
  promising an `npx --no-install` fallback that `hookCommand()` had stopped
  emitting — the sentence the user reads at the moment the hook is installed
  described the network-reaching mechanism that was removed for reaching the
  network. `TG-README-HOOK-MATCHES-THE-CODE` is now a claim about the
  property, over all four surfaces. The fourth, `docs-canonical/SECURITY.md`,
  was found by DocGuard while this claim was being widened from one to
  three; it is correct today, and is checked because that is where the
  sentence lives, not because a defect had been found there.
- **A test runner that has already exited is not reported as contention.**
  `ps` is a snapshot, and a suite that finished between the snapshot and the
  warning produced "1 test runner is already running (pid 65751)" for a process
  the operator could not find. Liveness is re-checked immediately before
  reporting. Detection stays best-effort: `EPERM` means running, not gone.
- **A release can tag itself even when `main` moves underneath it.** A GitHub
  App may not *push* a ref whose `.github/workflows` differ from the current
  default branch, so v0.8.1's tag was refused seven minutes after an unrelated
  workflow PR merged — a release that was otherwise complete. `create-release`
  still pushes first, and now falls back to creating the tag through the API,
  which adds a ref to a commit already in the repository and so is not subject
  to that restriction. Any other push failure is still fatal and says so.
- **A release that cannot open its pull request says why.** `GITHUB_TOKEN`
  cannot call `createPullRequest` unless "Allow GitHub Actions to create and
  approve pull requests" is enabled, and v0.8.1 hit exactly that: the branch,
  the bump and the diff were all correct and the run still ended in a bare
  `GraphQL: GitHub Actions is not permitted to create or approve pull
  requests`. Both `scheduled-release.yml` and `release.yml`'s `homebrew-sha`
  job now name the setting, give the one-line `gh api` equivalent and the
  manual `gh pr create` fallback, and say what stays stale until it is fixed.
  The failure is still a failure: the branch exists without a PR, and for the
  formula `detect-version` keeps reporting the hash owed on every sweep.

### Changed
- **The calibration counts escaped bugs, not every commit that changed source
  and a test together.** `p` is P(the suite misses it | a *bug* of this class
  escapes), but the corpus was every commit with a source-and-test pair — which
  in a conventional-commits repository is every feature, since a feature ships
  with its tests as a matter of course. One run reported "12 of 12 measurable
  bugs invisible — 100%" over five `feat:`, a `refactor:`, a `style:` and a
  commit whose entire purpose was adding a test; only four were `fix:`. The
  finding survived the correction — all four real fixes came back `blind` — and
  is stronger stated over the four honestly than over the twelve loosely.

  Selection is unchanged: the source-and-test pairing is still all that can be
  judged without reading a subject line, and replaying a feature still measures
  something. What narrows is the estimator. Where a majority of replayed
  subjects carry a conventional type, `p` is computed over the `fix:`/`revert:`
  records; `replay` prints both rates and the type breakdown so the narrowing
  can be checked; and `calibration.json` records which rule produced it in
  `source.detail`, so two calibrations from two populations can never be
  compared by accident. A conventional repository with no `fix:` in range
  calibrates nothing and says to widen the range, rather than silently counting
  features as bugs.
- **`baseline` stops printing advice that rots, and stops repeating it.** It
  named `.testguard/evidence.json` and `.testguard/brief.json` long after the
  tool had grown to ten regenerated outputs, and printed them every run whether
  or not the project already ignored them. The list now lives in one place,
  owned by `init`, and only the outputs a project does not yet ignore are
  printed — asked of git, so `.testguard/*` with negated exceptions, a global
  ignore file and `.git/info/exclude` all answer correctly. `replay.json`,
  `calibration.json`, `ci-self-evidence.json` and `.testguard/ci/` were missing
  from the list `init` writes and have been added.
- **The weekly release starts its own CI, so no human step is left.** A pull
  request opened by `GITHUB_TOKEN` raises no `pull_request` event, so the three
  required Node legs never started and auto-merge sat on checks that would
  never run — the workflow simply printed `gh workflow run ci.yml --ref
  release/vX.Y.Z` and waited for someone to read it. It now dispatches that
  run itself, as `release.yml`'s `homebrew-sha` job already did, guarded so a
  re-run does not queue a second identical run. With
  "Allow GitHub Actions to create and approve pull requests" enabled, a
  release now needs no manual step at all.
- **The cost budget records a from-scratch release measurement.** 999 s for
  115 faults on the v0.8.1 release commit, corroborated at 988 s on the
  commit before it, against the unchanged 1100 s ceiling. The previous record
  was 962 s at 96 faults.

### Performance
- **The self-probe cost budget is 1350 s, from 1100.** Six new claims and 14
  new faults took the gate from 115 to 129 faults and 690 to 774 runs, and CI
  measured 1123 s against the 1100 ceiling. The budget exists to make exactly
  this visible rather than let it pass, so the raise is recorded with its
  measurement and its reason in `testguard.cost-budget.json`. Two caveats are
  written down there: the 1123 s run restored a cache under the fallback key
  and so reused some verdicts, which makes it a floor rather than the
  from-scratch figure this budget is defined against; and the number is
  expected to come back down, because 44% of the gate is two shared defender
  files re-run once per claim that names them. A third is recorded too: the
  reported total is modelled rather than wall clock, because a reused record
  contributes what it cost when it was last probed, so the same commit
  measured 1123 s and then 1025 s depending on what the cache restored.
- **The new calibration claim costs 4.9 s instead of 51 s.** Its tests are
  pure — no git, no fixture corpus, no scratch worktree — but they were added
  to `replay.test.mjs`, whose scripted-corpus setup costs tens of seconds a
  run, and a claim pays for every test in the file it names. Moved to
  `calibration.test.mjs`, which exists for exactly this, and the claim
  re-pointed. Same two faults, still killed 2/2.

### Documentation
- The README shows an ignore-file entry. It was mentioned twice without one,
  so the field name (`pattern`, not `value`) and the fact that `expires` is a
  full timestamp rather than a date had to be discovered from a validator
  refusal.
- `--help` shows `gate --changed HEAD --include-dirty`. `--include-dirty` needs
  a reference, and that combination is the one form a pre-commit hook wants.

## [0.8.1] - 2026-09-18

Automated weekly release — everything merged since `v0.8.0`.

### Changed

- fix(release): the release allow-list is derived, not retyped (#100)
- fix(release): the weekly release verifies the tree it is about to ship (#99)
- ci(release): set the Homebrew sha256 from the published tarball (#98)
- chore(homebrew): sha256 for v0.8.0, from the published tarball (#97)


### Fixed
- **A release is no longer blocked by an allow-list that forgot one of its own
  surfaces.** `sync-release-version.mjs` rewrites
  `packaging/gitlab/testguard.gitlab-ci.yml`, and that path was missing from
  both release guards: `scheduled-release.yml` would have failed with
  "unexpected file in release diff" for a file the release exists to write,
  and `auto-merge.yml` would have held every release PR for human review. The
  script gained `--list-surfaces`, derived from the same table the writes use;
  `scheduled-release.yml` now builds its allow-list from that instead of a
  retyped copy. `auto-merge.yml` keeps an explicit list on purpose — it is the
  gate that merges without review — and a test now fails when that list omits
  any release surface. Claim `TG-RELEASE-SYNC-CHECK-FAILS-ON-DRIFT` gains a
  fifth fault.
- **The weekly release workflow can actually cut a release.** Its "verify the
  tree is still green" step probed in worktree mode straight after syncing the
  version surfaces, so the probe refused to run: the sync leaves
  `packaging/gitlab/testguard.gitlab-ci.yml` uncommitted and that file is the
  fault target of `TG-GITLAB-PROBE-EXIT-PRESERVED`, which worktree mode
  correctly treats as a dirty defender (exit 2). It now probes with
  `--include-dirty`, which verifies the bumped tree that is about to be
  released rather than the version before it. `scheduled-release.yml` had
  never completed a run since the GitLab template became both a sync surface
  and a fault target on 2026-09-17; every release so far was cut by hand.
- **The Homebrew formula's `sha256` matches its own `url`.** It had carried
  `385d69f9…` unchanged across v0.6.0, v0.7.0 and v0.8.0 while
  `release:sync` bumped the `url` each time — a hash that matches none of
  the 0.4.0–0.7.0 tarballs, so `brew install` from the staged formula could
  never have verified. Set to the sha256 of the published
  `testguard-cli-0.8.0.tgz` (`5305ce22…`), computed from the registry, not
  from a local `npm pack`.
- **`release.yml` sets the Homebrew `sha256` itself, after publishing to npm.**
  The formula header used to tell a human to run `curl | shasum` each release,
  and nobody did. `sync-release-version.mjs --sha256` now waits for the
  registry to serve the tarball (a publish is `PUT 202`; the file can lag by
  minutes), hashes exactly the bytes Homebrew will download, and writes the
  formula only when the value changes; a `200` that is not a gzip tarball is
  refused, never hashed. `main` is protected, so the change lands as a bot PR
  with auto-merge armed and CI dispatched by the workflow. The hash is a
  release surface like the URL beside it: `detect-version` compares the
  formula against the tarball (`--check --online`) on every hourly sweep, so
  a failed run is retried the way a failed publish is, and `--check` refuses
  the `385d69f9…` placeholder outright. Claim
  `TG-RELEASE-SYNC-CHECK-FAILS-ON-DRIFT` gains three faults for the new modes.
  Only the next release exercises the workflow path end to end.

## [0.8.0] - 2026-09-18

A calibration you can quote.

A calibration document now says what its number means and where its labels
came from, and it reproduces: `p` and every interval are recomputed by the
validator from `n`, `positives`, `method` and `confidence`, at the document's
own precision — the spec's own example had carried a truncated bound since
the day it was written, and nothing could notice. `nocover` counts as the
miss it is, so a project with no tests at all for a subsystem no longer
outscores one with weak tests. The format also carries what
websec-validator's shipped table already said — corpus, caveat, a producer
floor, backoff tiers, a labelled prior — so a second tool's honesty survives
translation; that table is now a conformance example, and "adoptable" means
the file validates rather than a sentence saying so. Underneath: the
self-probe gate is held to a cost budget (#89), and a reserved method has
somewhere to put its data (#91).

### Added
- **A calibration can now say what it measures and where it came from** (#82).
  websec-validator's shipped `calibration.json` already carried `corpus`,
  `min_n`, `caveat`, `evidence_status` and `limitation` — the fields that say
  "indicative, do not quote this number" — and claimspec had nowhere to put
  them, so adopting it would have stripped that honesty in translation. It
  also had nowhere to say what `p` *was*: testguard's is a miss rate where
  high is bad, websec's is P(real) where high is good, and both validated
  identically. The schema gains `measures` (a registry: `escape-missed`,
  `finding-real`), provenance in `source` (`corpus`, `caveat`, `limitation`,
  `evidenceStatus`, a `tool-oracle` kind, and an unconstrained `detail` on the
  `methodDetail` pattern), a producer floor `minN` that consumers may raise
  and never lower, ordered `backoff` tiers so a class→label→prior cascade is
  expressible, a `fallback` whose shape says it is a guess, a per-cell
  `breakdown` that sums to `n`, `p: null` at `n = 0`, and `|`-compound bucket
  keys whose arity the validator checks. Every field is optional and absence
  means *unattributed* — readable, not quotable — so no existing document
  breaks; testguard's emitter always writes them and a self-claim guards it.
  The proof of adoption is a file, not a sentence: websec-validator's table,
  translated field for field, is now `spec/conformance/examples/calibration-websec.json`
  and validates with every number reproducing. `GATE-SEMANTICS.md` records
  the merge rule (sum counts, recompute, never average; only when `measures`
  and `bucketBy` agree) that websec's shipped-plus-local overlay already
  depends on.
- **The gate is now gated on its own cost** (#89). `--cost` has printed the
  self-probe's wall clock into every CI log since #67, and the gate still went
  from 9.6 to 23.6 minutes across one merged change without anything saying a
  word. A measurement nothing gates on is not a check — which is the premise
  this tool rests on, applied to itself.
  `testguard.cost-budget.json` carries the ceiling, its measurement and why it
  is set where it is. CI fails when the probe exceeds it and opens with the
  most expensive claims, so the first thing a failure shows is where to look.
  Raising it is a committed diff with a reason: growth is allowed, going
  unnoticed is not.
  The budget is on the **total**, never a per-fault average. The regression
  that prompted this took the corpus from 59 faults to 91 while per-fault cost
  barely moved — an average would have reported everything fine while the gate
  tripled, and a test says so. A budget that is missing or not a positive
  number is refused rather than treated as unlimited, so a typo cannot quietly
  disable the gate.


### Fixed
- **The cost budget is set against what CI measures.** 950 s was 18% over
  the local 804 s figure and only 4.6% over the 906 s CI already measured on
  `main`, so the first pull request to add any claim tripped it — #94 passed
  its own leg only because the cache reused verdicts, and `main` went red at
  981 s from scratch the moment it merged. Raised to 1100 s (~14% over the
  962 s CI measures with #82's re-pointed defenders), with the CI figures
  recorded beside the local one so the next person budgets against the
  number the check actually sees. The heavy claims the failure now names are
  the next #73-style cut.
- **Calibration's pure tests moved off the replay fixture** (the #73 pattern).
  Three calibration claims were defended by `test/replay.test.mjs`, which
  builds a scripted git corpus on every run; their kills come from pure
  `calibrationFrom` tests that need none of it. The cost budget fired on the
  first full run — 1022 s against 950 s, the top rows being exactly those
  claims — so the tests now live in `test/calibration.test.mjs`, the claims
  point there, and every fault was re-probed after the move, not assumed.
- **A cost-budget failure names its claims.** `checkCostBudget` read `id`
  from a report whose claims carry `claimId`, so the one line meant to say
  *which* claims to look at printed `undefined` five times — and its unit test
  fed the shape the code wished for, so it passed. Found the first time the
  budget actually fired. The test now goes through `costReport`, and
  `TG-COST-BUDGET-NAMES-THE-CLAIM` guards it.
- **A calibration counts `nocover` as a miss** (#82). `nocover` — no test
  even imports the broken file — is the worst replay outcome, and the ratio
  excluded it: a project with no tests at all for a subsystem scored *better*
  than one with weak tests, because its worst outcomes left the denominator
  before the ratio was taken. It now enters both sides, as it does in Stryker
  and PIT, and the replay summary says how many misses were blind and how many
  had no test at all. The schema description, the emitter's docstring and
  `GATE-SEMANTICS.md` had also disagreed about what `p` was — "P(finding is
  real)" in one place, the miss rate in another, and the docstring's two
  sentences conditioning on different denominators — and now say one thing:
  for testguard, the share of real escaped bugs the suite failed to catch.
- **A calibration's arithmetic is checked, not trusted.** The validator
  recomputed nothing: it checked that `p` sat inside `ci` and would pass a
  document with every number invented. It now recomputes `p` from
  `positives / n` and `ci` from `n`, `positives`, `method` and `confidence`
  with `spec/lib/wilson.mjs` — one implementation, shared with the emitter —
  at the document's own precision, accepting either the exact quantile or the
  textbook 1.96. The spec's own example had carried a truncated lower bound
  (6/30 → `0.09`; Wilson gives 0.0950 → `0.10`) since the day it was written,
  and websec-validator's shipped table reproduces exactly.
- **A reserved method can now say something.** #81 reserved `assertion` and
  `scan` without required fields, and `fault` / `detail` are both
  `additionalProperties: false` — so a probe using a reserved method could
  declare that it existed and **nothing whatsoever about it**: not which rule
  was checked, not where. That is not a reservation, it is a dead end, and
  DocGuard's writer would have hit it on its first line.
  Both now carry `methodDetail`: an object the spec deliberately does not
  constrain, on the probe and on the record. It is **forbidden under
  `fault-injection`**, whose shape is specified and must not acquire a junk
  drawer — a self-claim fails if that ever stops being enforced — and it is a
  staging area rather than a permanent home. What the first real consumer puts
  there is the evidence for what the specified shape should become.

## [0.7.0] - 2026-09-18

Python, and a fault that cannot hide.

TestGuard now probes Python projects with nothing installed into them, and it
no longer takes a green suite at its word: a fault applied to code the tests
never execute used to be reported as SURVIVED — an audit finding that reads as
devastating and is entirely false — and is now `unverifiable`, because the
defenders are made to prove they can fail because of that file before a
survival about it is allowed to stand.

Alongside: the shared spec is named `claimspec` and no longer assumes fault
injection is the only way to falsify a claim, one bad fault can no longer cost
the evidence for the whole run, and the self-probe gate was measured rather
than guessed at.

### Upgrading

**Some claims that were `survived` will become `unverifiable`, and your frozen
baseline will not suppress them.** This is the intended consequence of the
negative control, and it is worth reading before you re-freeze anything.

A fingerprint is derived from the claim, the subject, the file and **the
verdict**. A claim whose subject the defenders never execute was reported
`survived`; it is now `unverifiable` with reason `subject-not-executed`. That
is a different fingerprint, so a baseline frozen before this release does not
contain it, and it gates as new.

**The finding is real.** It says the defenders do not execute that file at all,
so every earlier verdict about it was a statement about their reach rather than
their assertions — including the `survived` your baseline was suppressing. A
`survived` you had accepted as known debt was, in these cases, not a measurement
of anything.

What to do, in order:

1. `testguard probe` and read the records carrying
   `detail.negativeControl: "not-reached"`. Each names a file no defender
   loads.
2. **Prefer fixing the defenders.** A claim whose subject is never imported is
   the cheapest blind spot you will ever find — cheaper than a survivor,
   because nothing was even tried.
3. If you are accepting it as existing debt for now, `testguard baseline`
   re-freezes today's findings so only newer ones gate. Do this **after**
   looking at them, not instead of.

`baseline --restamp` is **not** the command for this: it moves a baseline's
`head` onto a clean identical probe, and it requires the same fingerprints.

Nothing else in this release requires migration. The `claimspec` rename changes
no emitted document, the `method` field defaults to `fault-injection` so every
existing claims and evidence file stays valid, and the gate work changed which
tests defend which claims, never a verdict.

### Added

- **A five-page technical brief**, [`docs/testguard-explained.pdf`](docs/testguard-explained.pdf):
  the whole idea on page one, the field measurements on page two, then
  mechanics, architecture and prior art. Six diagrams, including a dot matrix
  of the 39 injected faults from the second field report — 21 survived a fully
  green suite, 39/39 killed after tests were written against the survivors. Built from
  `docs/testguard-explained.html` with `node .github/scripts/build-one-pager.mjs`
  (headless Chrome, so the one pinned runtime dependency stays one).

### Changed
- **A probe says which method produced it, and fault injection is no longer
  assumed** (#81). `claims` required `file`, `find` and `replace` on every
  fault; `evidence` required `confirmRuns`, `mode`, `defenders`, `inputs` and
  the baseline and probe runs on every record. All of those are what *fault
  injection* means by showing its work — and DocGuard verifies claims by
  reading code while websec-validator scans a surface, so neither could
  conform without emitting empty arrays, which is lying, and the one thing
  this format exists to make impossible.
  A probe now carries `method`, and a run says which method produced it.
  **It defaults to `fault-injection`, so every document written before the
  field existed validates unchanged** — verified against this repository's own
  88-claim file and every conformance example, none of which carries the field.
  The injection requirements did not disappear, they moved: the schema asks
  for them only under `fault-injection`, and the validator enforces them there
  in full. Relaxing the schema so a scanning tool can conform is not a licence
  for an injecting tool to stop showing its work, and a self-claim now says so.
  `assertion` and `scan` are **reserved**: their required fields are
  deliberately unspecified, to be defined by their first real consumer with
  conformance examples written from the shape that tool actually has.
  Designing them for an absent tool is exactly the mistake that made this
  change necessary — the spec was drafted against a single consumer and
  hard-coded its assumptions as requirements.
- **The self-probe gate, re-measured and cut** (#73). `--cost` at `ffaaa81`
  reported **1414 s across 546 defender runs for 91 faults** — back where #67
  started, because #77 took the corpus from 59 faults to 91. The gate did not
  decay; the workload grew, and nothing gated on that.
  The issue's original table pointed at `test/replay.test.mjs`. Measurement
  disagreed: that file is 138 s across *six* claims, about 23 s each, the
  cheapest per-claim cost in the top ten — the table had read a cumulative
  column as a per-claim one. The real cost was four claims paying an
  end-to-end fixture probe, 33 to 37 s a run, to falsify decisions that are
  pure functions.
  Each was re-pointed at a test that does not need the expensive setup, and
  **each was then re-probed rather than assumed**: 7 faults, 7 killed, 92 s
  where they had cost about 860 s.
  - `checkProvenance` is now exported and unit-tested. It was already a
    standalone function, and only a 33 s Python fixture probe could falsify it.
  - `argvFor` is pure, and its own comment says it is "exported so it is
    falsifiable without spawning anything" — while the claim still paid two
    fixture probes. `test/runner-argv.test.mjs` asserts the argv directly in
    126 ms, and covers `selectRunner`'s unknown-name guard too.
  - The isolation fault needed new work before it could move: forcing
    isolation to in-place left every fast test green, because they all probe
    in place anyway, so only the 37 s fixture noticed. Caught by injecting the
    fault by hand before trusting the re-point — the same trap that made two
    of five claims survive in #67.
- **`TG-PIPELINE-REPRODUCES-THE-ORACLE` is restated as
  `TG-PROBE-NEVER-EDITS-THE-TREE-IT-MEASURES`**, both faults carried over
  unchanged, the old id retired through the ignore file with a reason.
  The old statement promised that a probe "reproduces the known-answer
  fixture's verdicts exactly", and **no fault in it ever falsified that
  half**: one removes the restore, the other forces in-place isolation, and
  both are about tree safety. A claim that is defended and still over-promises
  is the one thing a probe cannot catch, so the statement was narrowed to what
  its faults actually prove — swapping the defender alone would have kept the
  over-promise and merely made it cheaper. The fixture oracle still runs on
  every `npm test` and in CI; it is no longer the defender of a claim whose
  cost it dominated.
- **The shared spec is named `claimspec`.** Schemas are now identified as
  `urn:claimspec:v1:<kind>` rather than `urn:guard-spec:v1:<kind>`.
  **No emitted document changes**: the identifier lives only in the schemas'
  own `$id`/`$ref`, the validator's registry and the documentation, so every
  evidence file, baseline, brief and status already written stays valid and
  keeps validating. Nothing needs migrating.
  The old name said which family of tools the formats came from. The name that
  matters is what they are *for* — claims, the evidence that tried to falsify
  them, and gating only the delta — and most of the tools that could adopt
  them (a scanner with an existing-violations problem, a mutation tester, an
  agent harness that needs `brief` and `status`) do no fault injection at all.
  `spec/README.md` now says so, and says plainly which kinds a second tool can
  adopt today and which cannot (#81).
- **The README leads with the plain explanation.** The research evidence is
  still there and still matters, but it is not the first thing a newcomer
  meets: an "In one minute" section now opens with what coverage cannot tell
  you, the `objectContaining` exhibit, killed vs SURVIVED, the seven verdicts,
  and — stated plainly — that mutation testing is from the 1970s and the novel
  part is binding every fault to a claim.
- The one-line descriptions on npm, PyPI and the GitHub Action now say what the
  tool does rather than what category it belongs to.

### Fixed
- **A vanished scratch worktree no longer costs the whole probe** (#64). A
  parallel session cleaning up its *own* leaked scratch worktrees deleted this
  run's while it was mid-fault; `restore()` then tried to write the original
  back into a directory that was gone, threw `ENOENT` out of a `finally`, and
  the probe died with no evidence file at all — every verdict already decided
  thrown away, and an exit code `GATE-SEMANTICS.md` does not define.
  In worktree mode the restore is belt-and-braces: the mutation only ever
  existed inside a scratch worktree that is discarded at the end of the run, so
  a target that has vanished is already restored in every sense that matters.
  It is now recorded as `detail.restoreSkipped: "target-missing"` — a reader
  can still see that the tree moved underneath the run — and the probe
  continues. Under `--in-place` the same condition is the user's own file gone
  and is still raised, loudly; so is any other failure to write the original
  back, in both modes, because a permission error can mean a mutated file left
  on disk.
  More generally, **one bad fault no longer costs the evidence for the other
  forty**. An unexpected throw inside a fault's probe ends *that fault* as
  `unverifiable` with reason `probe-error` and a `detail.message` naming what
  threw; the run finishes and writes its document. The verdict gates, so the
  failure is loud rather than absorbed into a green run, and a `probe-error`
  record is never reused by a later run — it says something about the run, not
  about the code. A **precondition** failure is the deliberate exception: the
  interpreter loading the source from outside the probed tree, or a runner that
  does not resolve, is a statement about every verdict in the run and still
  refuses it outright.
- **A prior verdict is no longer reused across a fault edit.** `probe` decided
  reuse from the source hash, the defender hashes and the defender set — never
  from the fault itself. So editing a fault's `find` or `replace` kept the
  verdict measured against the fault it replaced: a weakened fault held the
  `survived` it earned before, and a repaired anchor held `unverifiable`, with
  the evidence reporting a result nobody had measured against the file's
  current contents. `status` flagged the changed hash afterwards, but by then
  the evidence had already said something untrue — and for a tool whose
  premise is that a fault edit can never be invisible, that was the wrong
  default. Reuse is now also keyed on the fault's content hash; a prior record
  that carries none is probed again, because the cost of re-measuring is a run
  and the cost of the other direction is a verdict nobody took.
  Found by using the tool on itself: repairing two rotted anchors left both
  claims reporting `UNVERIFIABLE (reused)` on the next probe.

### Added

- **A survivor now has to prove the defenders execute the subject** (#74). A
  green baseline makes one failure mode structurally impossible — a misread
  runner cannot flatter the suite, because a kill requires the defenders to
  pass on unmodified source first. It says nothing about the opposite
  direction. If the fault is applied to code the test process never executes,
  the baseline is green, every probe run is green, and **every claim is
  reported SURVIVED**. That output reads as a devastating audit finding and is
  entirely false, and nothing in the run contradicts it, because every
  individual check passed.
  This is not hypothetical: a strict editable Python install registers a meta
  path finder that is consulted before `sys.path`, so the interpreter loads the
  original module while TestGuard faults the copy in its scratch worktree.
  Measured, not argued — a fault independently verified to fail 2 of 4 tests
  reported `4 passed`.
  A would-be `survived` is now charged one more run: the subject is replaced
  with content its loader cannot parse, and the defenders run once. Going red
  proves they execute it (`detail.negativeControl: "reached"`) and the verdict
  stands. Staying green proves they do not, and the verdict becomes
  `unverifiable` with reason `subject-not-executed`. Charged **only** on a
  survivor — a kill already proves the defenders reached the code — and cached
  per subject and defender set. Each runner supplies what "cannot compile"
  means for its language; one that cannot say does not guess, and no control is
  run.
  The predicate is *"the run did not stay green"*, not *"a test failed"*: an
  unparseable module usually fails to **load**, which the runner reports as an
  error with no tests run at all.

- **A runner pinned to one engine keeps every capability the module has.**
  `pinned()` rebuilt the runner as an explicit allow-list of properties, so
  `--runner pytest` and `--runner unittest` silently lost the negative control
  that `--runner python` has: a survivor probed through either flag was never
  checked, and an unreachable subject reported `survived` exactly as before.
  Found by the Python fixture, not by the unit test, which iterated the four
  runner modules rather than the registry the tool actually resolves through —
  it was checking the code that was written instead of the code that runs. The
  test now iterates `RUNNERS`, which is what makes the next capability added to
  a runner fail loudly instead of quietly.

- **`--progress auto|tty|plain|ndjson|none` on `probe`** (#68). A probe used
  to print its stage line only when `stderr` was a terminal, so CI, a
  redirected log and an agent harness saw nothing at all for the whole run —
  indistinguishable from a hang, and a gate you cannot tell from a hang is a
  gate people start killing.
  The carriage-return rewriting is a *rendering* choice, not a reason to
  withhold the information. `auto` (the default) keeps the rewritten line at a
  terminal and prints append-only lines everywhere else. `ndjson` emits one
  JSON object per line for stages **and** for verdicts as they land, so a
  machine can watch a probe without waiting for the document at the end.
  Progress always goes to **stderr**, so `--json` leaves stdout as one
  parseable document. `--quiet` and `--json` imply `none`; an explicit
  `--progress` overrides both, because an operator who asks for a stream of
  events has said what they want.
  Self-claims `TG-PROGRESS-NOT-ONLY-FOR-A-TTY`, `TG-PROGRESS-NEVER-ON-STDOUT`
  and `TG-PROGRESS-EXPLICIT-WINS`, all probed and killed.


- **`--cost`, on `probe` and `claims`** — what the defenders actually cost,
  per claim and per defender file, read back out of the `durationMs` the
  probe already records. It re-measures nothing and spawns nothing.
  A probe's wall clock is `(baseline runs + faults × --confirm) × the cost of
  the claim's defender SET`, per claim, so one slow acceptance test named by
  five claims is paid for thirty times — and until now nothing in the output
  said which file that was. The report names it, under **shared defenders**,
  with the claims that pay for it.
  Per-file figures are an **upper bound, not a share**: a run executes the
  whole defender set at once, so the runner never says how much belonged to
  which file. They overlap by construction and do not sum to the total, which
  the report says on its own face. Only `totalMs` is additive.

- **DocGuard governs this repository's documentation.** Six canonical
  documents under `docs-canonical/` — architecture, data model, security,
  test spec, environment and requirements — written against v0.6.0 rather
  than generated as templates, plus `DRIFT-LOG.md` for deliberate,
  recorded deviations. Every validator passes: structure, doc sections,
  changelog, test spec, environment, security, freshness, traceability,
  docs-coverage, document lifecycle and TODO tracking. Structural maturity
  99/100.
- **Requirements are traceable to tests.** Fourteen functional and eight
  non-functional requirements, each carrying an `@req` annotation in the
  test that verifies it, and a traceability matrix that must agree with
  those annotations. 27/27 traceability checks pass.
- **Doc drift is caught automatically, not reviewed by hand.** `ci.yml`
  runs `docguard guard` on every pull request — authoritative, unbypassable
  and visible in review — and reports the maturity score without gating on
  it. `.pre-commit-config.yaml` gives contributors the same checks locally,
  opt-in per clone, alongside the claims check, the change gate and the
  probe on pre-push.
- Every configuration file in the repository is now documented in
  `ARCHITECTURE.md`, including the distinction between
  `.pre-commit-hooks.yaml` (what we publish for consumers) and
  `.pre-commit-config.yaml` (what contributors to this repository use).
  README gains the `Usage` section the Standard README spec expects.
- **A Python runner** (`--runner python|pytest|unittest`, and `auto` when no
  JavaScript runner resolves). `pytest` when the project's interpreter can
  import it, stdlib `unittest` when it cannot; the engine that actually ran is
  what `run.runner.name` records, and `--runner pytest` / `--runner unittest`
  pin the choice and fail rather than fall back. **Nothing is installed into
  the project under test**: the reporters ship inside TestGuard and reach the
  interpreter through `PYTHONPATH`, so a codebase whose test dependencies are
  the standard library stays one. A `.py` defender runs under Python whatever
  the project runner is, so one claim can be defended by a vitest test and a
  pytest test at once.
- `--python <path>` (or `TESTGUARD_PYTHON`) names the interpreter. Otherwise:
  the active `VIRTUAL_ENV`, then the project's `.venv`/`venv`/`.env`, then
  `python3` on PATH. An interpreter you name is the only one tried — TestGuard
  never quietly substitutes another, which would change what the tests ran
  against without changing anything the evidence says.
- **An import-provenance precondition, and `detail.targetNotImported`.** A
  green baseline proves the harness is not reporting everything as broken. It
  proves nothing about the opposite direction, and Python can reach it: a
  strict editable install puts an import hook ahead of `sys.path`, so the
  interpreter loads the original file while TestGuard faults the copy. The
  baseline stays green, every claim is reported `SURVIVED`, and the result
  reads as a devastating finding while being entirely false. With the fault
  applied, TestGuard now asks which file was actually imported: loaded from
  outside the tree being probed **refuses the run**; never imported at all is
  recorded as `detail.targetNotImported` and warned about, because an import
  in a branch the fault does not reach is legitimate.
- **`target-attribute-patched`**, a new defender signal. `patch("pkg.mod.fn")`
  is not `vi.mock("./mod")`: it replaces one attribute, so the file still
  detects a fault anywhere else in that module. Applying the JavaScript rule
  would have dropped such files and reported `nocover` for well-defended
  claims. Only a patch of the module itself removes a defender; an attribute
  patch keeps it and names the attributes.
- Python fault producers for `testguard scaffold`: `condition-forced`,
  `statement-deleted`, `return-altered`, `literal-changed`, `call-removed`,
  `field-dropped` and `argument-swapped`, in Python syntax. A statement is
  removed by replacing it with `pass` rather than deleting the line, and a line
  that leaves a bracket open is never removed — both because a fault that
  cannot compile is a probe run that says nothing about the tests.
- Python defender discovery, mock-awareness and blast radius: matched by module
  name, the way Python itself matches, so `import`, `from … import`, aliases,
  relative imports and `importlib.import_module` all resolve.
- `fixtures/known-answer-python/`: sixteen faults covering every verdict, each
  verified by hand before it became the oracle, and reproduced under **both**
  engines.

### Changed

- **The self-probe gate no longer runs a fifty-second acceptance test thirty
  times.** Five claims named `test/probe.fixture.test.mjs` as their only
  defender, which is what made the release gate take ~24 minutes. The
  decisions those claims are about — how escalation attributes an undeclared
  killer, what counts as a measurable run for the flake rate, which binary a
  runner invokes, what makes a fault edit visible — are rules you can state in
  three lines, and none of them needs a fixture to falsify. They are now pure
  functions in `src/probe/attribution.mjs` and exported `argvFor` builders in
  the runners, unit-tested in `test/attribution.test.mjs` (~0.5s).
  This mirrors why `classify()` has always been pure: the order of its checks
  *is* the spec, and every branch should be falsifiable without a runner.
  No claim was weakened to get there. Each re-pointed claim was re-probed and
  still **kills** its faults; two of them SURVIVED on the first narrowing
  attempt, which is exactly the failure mode `--cost` now makes visible before
  someone ships a cheaper, weaker gate.
  **Measured on the same machine, serially, from scratch: 24.1 min → 9.6 min**
  (68 faults, 68 killed, 0 unproven). `--cost` names what is left: the jest
  and replay suites now dominate, at 207s and 148s of defender time.

- Style exceptions in the canonical documents are declared with a reason
  (`docguard:quality ... off — why`) rather than satisfied by rewording.
  This tool is defined by what must not happen — no network, no telemetry,
  never optimistic under uncertainty — and stating those positively would
  misdescribe them. A declared, reasoned exception is auditable; contorted
  prose is not.
- `--runner` accepts `python`, `pytest` and `unittest`; `--runner auto` tries
  vitest, then jest, then python. A JavaScript project with neither vitest nor
  jest installed now also reports why Python did not resolve.
- The GitHub Action and the GitLab template take `runner` and `python` inputs.

### Fixed

- `gate --changed` treated a changed `.py` file as `non-source` and excluded it,
  so it could never be reported as uncovered. Python is source; Python test
  files (`test_*.py`, `*_test.py`) are tests.
- `walk()` descended into `.venv`, `venv`, `site-packages`, `__pycache__`,
  `.tox`, `.nox` and the pytest/mypy/ruff caches. Every `test_*.py` of every
  installed package was collected as a test file of the project under probe.
- `testguard claims` printed a JavaScript comment marker (`// unasserted:`)
  when suggesting how to annotate a mock in a Python file.
- A `--runner-cmd` whose reporter emits something other than the jest-compatible
  JSON shape produced `unverifiable / defenders-failed-to-load` with no message
  at all. The verdict was already safe — a report with no recognised tests is a
  non-green baseline, never a pass — but nothing said why. It now names the
  mismatch.

## [0.6.0] - 2026-09-17

Everything the field asked for. Two independent field reports on private
AI-authored codebases drove eleven issues; this release closes all of them,
alongside the roadmap work that landed beside it.

**Read this before upgrading.** Defender discovery is now mock-aware: a test
that `vi.mock`s or `jest.mock`s the subject can detect no fault in it and is
no longer counted. Claims defended only by such tests therefore move to
`NOCOVER`, which is the truth those verdicts always should have told. Expect
new findings on the first probe after upgrading, and re-freeze your baseline
once you have read them — they are not regressions in your code, they are
blind spots that were previously invisible.

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
- **The session-start hook resolves an installed `testguard` and contains no
  form of `npx`** (#24): the project's `node_modules/.bin`, then the git
  root's, then `command -v testguard`, then nothing — it exits 0 with no
  output rather than break a session. Any earlier npx hook, `-y` or
  `--no-install`, is replaced on the next `init`. The brief's first line
  names the install that answered.

  `--no-install` is **quiet, not offline**, which is why it is gone too:
  measured, `npx --no-install --loglevel=http testguard-cli --version` in a
  project with nothing installed logs
  `npm http fetch GET 200 https://registry.npmjs.org/testguard-cli`, and
  against an unreachable registry it exits non-zero. npm resolves the
  packument before deciding not to install.

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

### Fixed

- **The README described a hook the code no longer writes.** Three passages
  still documented the `npx --no-install` fallback that this release removes,
  one of them repeating the "never fetches from the network" wording the
  measurement above disproves — in the security-relevant paragraph, in a
  release about detection power. Corrected, and now checked mechanically:
  every `||`-chained `brief --text` command in the README must be one
  `hookCommand()` actually emits, and the phrase "falls back to npx" is
  banned outright. Both regressions were verified to fail the check before it
  was accepted. Self-claim `TG-README-HOOK-MATCHES-THE-CODE`.
- **A claim can be defended and still over-promise, and no probe can catch
  that.** `TG-INIT-HOOK-NO-NETWORK` was killed 3/3 on every run while the
  code it guarded could still reach the registry: the fault matched the
  code, the code matched the test, and the *statement* was the thing that
  was wrong. Fault injection measures whether a test would notice the code
  changing; it cannot measure whether the sentence a human wrote is true of
  the world. That is the standing limit of this method, and the only remedy
  is reading claims against reality — which is what happened here. The
  statement and its fault were corrected together.
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
