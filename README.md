# TestGuard

<!-- docguard:quality negation-load off — this README explains a tool defined by what must not happen; the negations are the product. -->
<!-- docguard:quality passive-voice off — verdicts and artifacts are the subjects throughout ("a fault is applied", "evidence is written"); naming an actor would misdescribe a tool nobody operates interactively. -->

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](./package.json)

> Breaks your code on purpose and reports every promise your tests did not
> notice breaking.

**Not a test generator. A claim verifier.** Test generation is what happens
after a claim turns out to be unfalsifiable.

Third tool following the Guard pattern, alongside
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ code) and
[`websec-validator`](https://pypi.org/project/websec-validator/) (attack
surface ↔ code). All three run one loop:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

## In one minute

**Coverage tells you a line ran. It never tells you anyone checked the
result.** So a codebase can be fully covered and completely undefended, and
nothing in CI will say a word.

Here is a real test, from this repository's own fixture:

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` ignores keys it does not list. Swap the redacted text for
the **raw secret** and this test still passes. Coverage of that line: 100%.
The audit log now leaks the very thing it exists to protect.

**The method: break the code deliberately, then watch what the tests do.**

- **killed** — you broke it, a test failed. Good. That behaviour is genuinely
  defended.
- **SURVIVED** — you broke it, everything stayed green. A blind spot.

The word trips everyone once: it is the *fault* that survived, not the test.
**SURVIVED is the bad news.** A healthy report is full of `killed`.

But *"did the tests fail?"* is a sloppy question — a red suite is not proof of
detection. So there are seven verdicts, and each means something different:

| Verdict | What it means |
|---|---|
| `killed` | A test body ran and rejected the behaviour. The only good outcome. |
| `SURVIVED` | Everything passed. A real blind spot in the tests. |
| `NOCOVER` | No test even looks at this code. Not "weak tests" — *no* tests. |
| `UNVERIFIABLE` | The fault could not be applied: its anchor moved, or matches twice. Nothing was learned. |
| `FAULT-INVALID` | The break itself was broken — it did not compile. Our fault, not yours. |
| `TIMEOUT` | The suite hung. A hang is not a detection. |
| `FLAKY-DEFENDER` | The tests are not reliable enough on untouched code to be asked the question. |

Every ambiguity rounds toward *unproven*: three runs rather than one, a green
baseline required before any fault is injected, and a timeout, a load failure
or a mixed result is never a kill. The reason is the constraint the whole
design follows from — **a tool that reports everything as caught is worse than
no tool at all, because nobody questions good news.**

**What is not new:** breaking code to test your tests is *mutation testing*,
and it dates to the 1970s. Stryker, PIT, mutmut and Cosmic Ray all do it.

**What is different is the question.** Classic mutation testing mutates
everything mechanically and hands you *"mutation score: 73%"* — a number that
is not actionable, not auditable, and cannot tell you which promise is at
risk. TestGuard binds every fault to a **stated claim**, so the output is not
a score but a finding: *"Your project says a missing scope fails closed.
Nothing checks that."* That is the difference between a metric and an audit.

📄 **[Read the three-page technical brief (PDF)](docs/testguard-explained.pdf)**
— the idea on page one, mechanics and prior art after it.

## Why

Coverage cannot tell a test that pins *correct* behaviour from one that pins
a *defect*. An agent that writes both the code and its tests encodes whatever
it believed — including its bugs — and the suite goes green.

Measured on a real, entirely AI-authored production codebase with ~4,900
disciplined tests (no snapshots, 0.4% zero-assertion): **8 of 9 real
historical bugs were invisible to the suite**, worst case 2,451 tests green
on known-broken code. The largest gap was a compliance-critical path with
100% coverage, where the one assertion that mattered used
`expect.objectContaining({...})` and omitted the field carrying the data.

A second, independent run on a different AI-authored codebase (63 test
files, 458 tests, 24 hand-written security claims, 39 faults): **21 of 39
faults survived a fully green suite — 9 of them critical.** Super-admin
gating, membership checks, cookie flags and the whole authorization callback
could be disabled without a single test noticing. One test file had
re-implemented the authorization logic *inside the test* and asserted
against the copy: fifteen green tests, zero detection. After wrapper-level
tests were written against the survivors, 39/39 were killed.

The peer-reviewed picture in 2026 says the same thing from the other side.
Coverage and mutation score of LLM-generated suites track effectiveness only
when the code under test is assumed correct; once it may be buggy they "no
longer serve as reliable indicators" ([Zhao, Zhou and Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)).
Buggy code steers a model toward tests that assert the bug, and prompting
with the specification is the mitigation that works ([arXiv 2607.22883](https://arxiv.org/abs/2607.22883)) —
which is why a claim here comes from intent, a fault is bound to the claim,
and the brief hands the agent the claim before it writes. And agents
saturate whatever tests they can see, with the gap to held-out tests
growing about 28 points per tenfold increase in code size ([SpecBench](https://arxiv.org/abs/2605.21384)).
Every generator on the market admits a test because it compiles, passes and
raises coverage. TestGuard admits it because it fails when the claim is false.

## Install

| How | Command |
|---|---|
| npx (no install) | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli` then `npx testguard probe` |
| pip | `pip install testguard-cli` then `testguard probe` (needs Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.6.0` — see [`action.yml`](./action.yml) |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.6.0/packaging/gitlab/testguard.gitlab-ci.yml` with `inputs:` — see [`packaging/gitlab/`](./packaging/gitlab/testguard.gitlab-ci.yml) |

Projects that set `min-release-age` in `.npmrc` cannot see a version published
less than that many days ago (`ENOVERSIONS`); install that one with
`npm i -D testguard-cli --min-release-age=0`.

## Usage

```bash
npx testguard-cli init                      # install the agent layer at the git root
npx testguard-cli status --json             # where the project is, and the ONE next action
npx testguard-cli claims                    # what does this project claim, and is each claim probeable?
npx testguard-cli scaffold src/auth.ts      # propose faults for a file, as a draft to keep or drop
npx testguard-cli probe                     # try to falsify each claim; report what the tests missed
npx testguard-cli admit test/auth.test.ts --claim AUTH-ADMIN   # does this test satisfy the two-gate rule?
npx testguard-cli baseline                  # freeze today's unproven findings; only new ones gate
npx testguard-cli gate --changed origin/main # fail when a changed source file carries no claim
npx testguard-cli brief --text              # tell the agent where the suite is blind, before it writes
npx testguard-cli replay --since v1.0..HEAD # would this suite have caught the bugs that escaped?
npx testguard-cli mcp                       # serve the read-only loop over MCP, on stdio
```

Exit codes are the contract: `0` nothing new to prove, `1` unproven claims or
unclaimed changes, `2` a precondition failed and nothing was probed, `3` usage.
Every command accepts `--json`.

## How it works

```bash
npx testguard-cli init        # install the agent layer: skill, session-start hook, AGENTS.md section
npx testguard-cli status --json   # where the project is and the ONE next action — the machine entry point
npx testguard-cli claims      # what does this project claim, and is every claim probeable?
npx testguard-cli probe       # try to falsify each claim; report what the tests missed
npx testguard-cli baseline    # freeze today's unproven findings; from now on only new ones gate
npx testguard-cli brief       # tell the agent where the suite is blind, before it writes
npx testguard-cli gate --changed origin/main   # fail when a changed source file carries no claim at all
npx testguard-cli scaffold src/x.ts   # propose faults for a file, as a draft to keep or drop
npx testguard-cli admit test/x.test.ts --claim X   # is this test green on HEAD and does it fail on every fault of X? ADMITTED or NOT ADMITTED
```

1. **Claims** live in `testguard.claims.json` (editors validate it against
   `"$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json"`):
   a statement, where it comes from, which tests supposedly defend it, and
   one or more *faults* — each a deterministic source change that would make
   the statement false. Every
   claim and every fault records who produced it. `testguard claims`
   validates the file and reports drift against `@claim <ID>` annotations in
   source. Test files are deliberately not scanned — a claim asserted by a test is the authorship trap the tool exists for — and annotation ids must contain a hyphen so prose is never mistaken for one.
2. **Probe** confirms the defenders are green N times unmodified, applies
   each fault in a scratch git worktree (your tree is never touched), runs
   the defenders N times, re-runs survivors against the whole suite with
   N-run attribution (up to N: it stops as soon as no test has failed in
   every run, because from there none can be named a killer), restores, and
   classifies. It warns when another test runner is already running — a
   contended machine turns a slow suite into a `TIMEOUT` verdict about the
   load, not the claim — records that on the evidence, and offers `--serial`
   to run one test file at a time. Verdicts are a closed set:

   | Verdict | Meaning |
   |---|---|
   | `killed` | a test body rejected the behaviour, N/N — the only pass |
   | `SURVIVED` | the defenders stayed green while the claim was false |
   | `NOCOVER` | no test file defends the claim at all |
   | `UNVERIFIABLE` | the fault's anchor is missing or ambiguous — loud, never a skip |
   | `TIMEOUT` | the defenders hung; a hang is not a detection |
   | `FAULT-INVALID` | the replacement does not load — a bad fault, not a finding |
   | `FLAKY-DEFENDER` | the defenders are not reliably green, or disagreed across runs — `detail.flakeRate` says how often (`failures` of `runs` on unmodified source) |

   Never a single score. Findings are ranked by severity, claim provenance
   and blast radius (relative imports, `tsconfig` path aliases and
   `package.json#imports` are resolved; bare package names are not), and
   written to `.testguard/evidence.json` — validated against the spec before
   it is written.

   Worktree mode probes a **commit**. If a defender or target file has
   uncommitted changes and you asked for the implicit HEAD, `probe` refuses
   and says so — otherwise your new tests would be silently absent and the
   same survivors would come back with no hint why. `--include-dirty`
   snapshots the working tree (tracked edits and new files) into a throwaway
   commit and probes that; your tree, HEAD and index are never touched. An
   **explicit `--ref`** (a pre-fix commit in a post-mortem, say) is honoured
   over a dirty tree, as is `--ignore-dirty`: a warning names the files and
   the evidence records them as `repo.ignoredDirty`, so the run says what it
   did not look at. Every summary names the commit probed.

   A claim with no `defendedBy` has its defenders **discovered**: the test
   files that import the fault's target, by relative path or resolved alias
   (tsconfig `paths`, through `extends` and `references`, vite/vitest
   `resolve.alias`, package.json `imports`) — **minus the files that mock
   it**. A test that `vi.mock`s / `jest.mock`s the target cannot detect any
   fault in it; counting it would make `NOCOVER` under-report and waste runs.
   `NOCOVER` therefore means exactly "no test file imports this source
   without mocking it". `claims` prints the split (`18 import · 16 mock · 2
   can detect`), the evidence lists the mocking files, and a mocking file
   that never `expect(...)`s anything imported from the target carries the
   static signal `mocked-never-asserted` — the cheapest blind-spot signal
   there is, and the exact signature of one escaped bug in the field
   reports. Silence it, visibly, with `// unasserted: <why>` above the mock.

   Runners: **vitest** and **jest** (`--runner auto` picks the first that
   resolves; both read the same jest-compatible JSON report). A runner is
   resolved from the **project's own package** first — its pinned version,
   its own bin script — and only then from an executable on PATH, which the
   evidence records as `runner.source: "path"`; `npx` is never asked,
   because its cache answers for packages a project does not have. Anything
   else goes through `--runner-cmd`. Each runner is proven against its own
   copy of the known-answer fixture.

   The two-gate rule, as one verb: `testguard admit <test-file> --claim <ID>`
   runs the claim's faults against your uncommitted test and answers
   `ADMITTED` (exit 0: the test is green on unmodified HEAD and fails on
   every fault, N/N) or `NOT ADMITTED` (exit 1: the first blocking fault and
   what to do about it). The test must be a declared or discovered defender
   of the claim. It is sugar over `probe --claim <ID> --include-dirty`, so
   it can never disagree with the gate. Every generator on the market admits
   a test because it compiles, passes and raises coverage; `admit` admits it
   because it fails when the claim is false.

   Practical loop: first pass `--no-escalate` (escalation re-runs the whole
   suite N times per survivor); iterate on one claim with `--claim <ID>` and
   either `--include-dirty` or `--in-place` (only fault target files must be
   clean there; test files may be dirty), optionally `--confirm 1` for a fast
   **provisional** signal — verdicts print with a `?`, evidence goes to
   `evidence-provisional.json`, and `baseline` refuses it; final pass with
   defaults. By default
   the stream shows only unproven faults plus a killed count — `--verbose`
   shows every fault. A custom
   runner (`pnpm --filter`, a specific config) goes in
   `--runner-cmd "<cmd> {files} … {out}"`; if the scratch worktree cannot
   see your `node_modules`, pass `--node-modules <dir>`.
3. **Baseline** freezes every non-passing fingerprint. Later probes suppress
   what was already known and exit non-zero only on what is new. Claims whose
   source and defenders are unchanged reuse their prior verdict, so a probe
   in CI costs only what changed. A baseline frozen from `--include-dirty`
   evidence records the snapshot and points at the *parent* of the commit
   that will carry your tests; after you commit, a clean `probe` plus
   `baseline --restamp` moves it to that commit — only when the fingerprints
   are identical, never otherwise. `status` notes a baseline that predates
   HEAD without making it a state.
4. **Brief** turns evidence plus baseline into a ranked, capped
   `## TEST BLINDSPOT CONTEXT` block, printed and also written to
   `.testguard/brief.json` (`--text` prints only; `--markdown` prints the same brief as a
   merge-request note for the human reviewer, unclaimed changes first). Wire it into an agent's session start
   — for Claude Code, in `.claude/settings.json`:

   ```json
   { "hooks": { "SessionStart": [ { "hooks": [
     { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
   ] } ] } }
   ```

   `--text` prints only, and exits 0 silently when there is no evidence yet;
   the command resolves the project's own install, then a `testguard` on
   `PATH`, and ends in `true` — so the hook can never break a session. There
   is no `npx` in it, in any form: `--no-install` resolves the package from
   the registry before declining to install it, so it is quiet rather than
   offline. The brief's first line says which install answered
   (`local install` or `global`), so a stale one is visible.

### Would this suite have caught the bugs that already escaped?

An injected fault is a fault somebody thought of. A bug that actually shipped
is ground truth: a human already confirmed it was a defect, and there is no
equivalent-mutant argument to have about it.

```bash
npx testguard-cli replay --since HEAD~50..HEAD --max 10
```

For each fix commit in the range — one that changes source **and** a test
together — `replay` checks it out in a scratch worktree, reverts only its
source files to the parent, **deletes the test the fix shipped** (that test
proves nothing about what the suite knew before it existed), and runs the
tests that import the reverted code:

| Verdict | Meaning |
|---|---|
| `caught` | a remaining test failed by assertion, every run. The suite knew. |
| `blind` | the suite stayed green on known-broken code. |
| `nocover` | no test imports the reverted files — worse than blind. |
| `flaky` | the runs disagreed, so nothing can be concluded. A flaky failure reads as detection, which biases this metric *optimistically*; mixed runs are never `caught`. |
| `unverifiable` | the revert did not apply, or the suite could not load. |

One patch counts once (`git patch-id`), because a dual-branch topology
carries the same fix under two or three shas. **`replay` reports and never
gates**: a bug that escaped is history, not a regression in this change.

Each replayed bug is also labelled with the injected-fault class its diff
most resembles, which is the join key that turns an uninterpretable mutation
score into a statement with a sample size:

```
  guard-removed          blind   7/9    p=0.78  ci [0.45, 0.94]
  field-dropped          blind   4/4    p=1.00  ci [0.51, 1.00]
```

Read as *"when a fault of this class survives, how often does that
correspond to a bug that really escaped"*. It is written as a
`calibration` document beside the replay one. Only `caught` and `blind`
carry information; the other verdicts are excluded from both sides of the
ratio.

**The open question this exists to answer.** Does a calibration learned on a
repository *with* history transfer to a greenfield one that has none? AI
authored code has no history, so replay cannot help it directly and
calibration is the only bridge. That transfer is unproven, it is the core
product bet, and this is the instrument for testing it — not the answer.

### Read CI's evidence locally

Verdict reuse makes a probe cheap, but the evidence lives where `probe` ran
and is gitignored. On a fresh clone, or on a laptop where CI does the
probing, the session-start brief is empty and `status` says `unprobed` while
the default branch has full evidence. Point either command at CI's document:

```bash
testguard status . --evidence .testguard/ci/ci-self-evidence.json
testguard brief . --text --evidence .testguard/ci/ci-self-evidence.json
```

A foreign document is not trusted blindly. `status` marks it
`evidenceSource: provided`, prints the commit it describes next to the
commit in your tree, and still computes staleness from the recorded input
hashes — so a file you have edited since CI probed it goes `evidence-stale`
for exactly those claims.

`testguard init --ci-evidence github` (or `gitlab`) writes
`.testguard/fetch-ci-evidence.sh`, which downloads the branch-named artifact
with the platform CLI you already have and then briefs from it. **It is an
on-demand helper, not a hook**: the session-start hook never touches the
network, and the helper exits 0 with a message when the CLI or the artifact
is missing. TestGuard itself still makes no network calls.

### Every change needs a claim

`probe` can only verify claims that exist. Every escaped defect in the field
reports so far was a **claim gap**: the feature shipped green with zero
claims, and a verifier with no claim about a feature is silent about it by
construction. `gate` closes that hole on the delta:

```bash
npx testguard-cli gate --changed origin/main            # in a PR: the files changed since the base branch
npx testguard-cli gate --changed HEAD --include-dirty   # before a commit: the working tree, staged or not
```

Every changed source file must carry a fault, resolve as a defender of a
claim (test files), or be excused by an unexpired `path` entry in
`testguard.ignore.json` — with a reason a reviewer will accept. One
unclaimed file exits `1`; there is no percentage. Every reliance on an ignore
entry is printed, so a reviewer sees *why* the gate passed; an expired entry
excuses nothing. Non-source files and documented never-claimed patterns
(`*.d.ts`, `*.config.*`, fixtures, mocks; `--explain` lists them) are
excluded and said so; `--strict` fails a change that evaluated nothing.

With a reference known, `status --changed <ref>` reports `unclaimed-changes`
**before** any evidence state and makes the claim the next action; the brief
lists the unclaimed files first. The claim is written before more code.

**In CI the base is detected** — GitHub Actions (`GITHUB_BASE_REF`) and GitLab
merge request pipelines (`CI_MERGE_REQUEST_DIFF_BASE_SHA`, then
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`); `TESTGUARD_CHANGED_REF` overrides both.
The base must exist locally: GitHub — `actions/checkout` with `fetch-depth: 0`;
GitLab — the diff base sha needs nothing extra on a merge request pipeline,
the branch name needs `GIT_DEPTH: 0` or a `git fetch origin <target>`. A
detected base that does not resolve is a warning for `status` and `brief`
(they keep working) and an error for `gate` (its whole job is the measurement).

```yaml
# GitHub Actions
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: raccioly/testguard@v0.6.0
  with: { command: gate }

# GitLab CI — the component-shaped template: gate + probe, brief as an artifact and, opted in, as a merge-request note
include:
  - remote: 'https://raw.githubusercontent.com/raccioly/testguard/v0.6.0/packaging/gitlab/testguard.gitlab-ci.yml'
    inputs: { dir: backend, post_note: true }   # post_note needs TESTGUARD_GITLAB_TOKEN (api scope); one note, updated in place
```

The template carries `spec: inputs:` (`version`, `dir`, `image`, `severity`,
`confirm`, `budget`, `no_escalate`, `strict`, `post_note`, `stage`), so
mirrored into a GitLab project it is a catalog component that a compliance
framework can require on every project in a group. The CLI itself never
talks to the network; only the job posts, and only when told to.

### Properties

- **Deterministic measurement.** No model decides a verdict. Faults are
  string substitutions from a reviewed file; verdicts come from the test
  runner's structured report, confirmed N times. The same inputs give the
  same evidence, which is what makes it replayable for an auditor.
- **No network, no telemetry.** The CLI never opens a socket. The
  session-start hook resolves an installed binary and never fetches one.
  Nothing leaves the machine unless a CI job you configured posts it.
- **Artifacts are data in the repository.** Claims, evidence, baseline and
  brief are JSON validated against a published schema before they are
  written. Nothing is healed, regenerated or re-targeted at run time; a
  claims file is code, and is reviewed like code.
- **Never optimistic.** A timeout, a load failure, a mixed N-run result, a
  flaky defender or a missing anchor is reported as unproven, never rounded
  toward green. The one pass is `killed`; everything else gates.
- **One exact-pinned runtime dependency** (`ajv`), Node ≥ 20, MIT.

### What TestGuard is not

- **Not a test generator.** It judges a test the agent wrote (`admit`); the
  generating half stays with the agent, where the market is putting it.
- **Not a mutation-score dashboard.** No blanket mutants, no single score, no
  threshold. Faults are few and bound to stated claims; findings are ranked,
  never summed.
- **Not a self-healing runner.** A defender that adapts itself to a change is
  a defender that did not observe it; TestGuard reports that, it does not do
  it.
- **Not a coverage tool.** A line executed says nothing about whether an
  assertion would notice. `NOCOVER` here means no test even imports the
  file; everything above that is measured by injecting the fault.

A claim that **disappeared** is invisible to all of the above: `probe`
verifies the claims that exist, `gate` sees the source file covered by some
other claim, and `status` says clean. Deleting a claim is therefore cheaper
than weakening its fault — and `changedFaults` exists precisely because
weakening was the cheap escape. So:

```bash
npx testguard-cli claims --since origin/main    # what existed there and does not now
```

`removed-claim` and `removed-fault` gate; a rename that keeps the statement
verbatim is reported as `renamed-claim` and does not. Where evidence is
present, the line names the verdict the claim last had, because *"it was
SURVIVED when it was removed"* is the sentence that matters. The escape hatch
is the same one as everywhere else: a `claim` entry in
`testguard.ignore.json` with a reason, expiring if you give it an `expires`.
Removal is allowed — claims can be wrong, superseded or split — and it is
never silent.

### Run it from any harness

The operating loop above lives in a Claude Code skill and a session-start
hook. Both vanish the moment the harness is Cursor, Codex, Devin or whatever
comes next — and the harness is exactly the layer most likely to change. So
the same documents are also served over the Model Context Protocol:

```bash
npx testguard-cli mcp            # JSON-RPC 2.0 on stdio
npx testguard-cli init --mcp     # prints the config for Claude Code, Cursor and Codex
```

Five tools, all **read-only**: `testguard_status`, `testguard_brief`,
`testguard_claims`, `testguard_evidence`, `testguard_next_command`.

**No tool runs a probe.** A probe is long-running, budgeted, and the person
should see it happen, so `next_command` hands back the exact shell line for
the agent to run in its own terminal. Nothing here writes a file either —
editing a claims file through a connector would defeat the point of recording
every fault edit. The server declares only a `tools` capability: no prompts,
no resources, no sampling.

It is hand-written against a pinned protocol version rather than built on the
official SDK, because this tool has one exact-pinned runtime dependency and
keeps it that way. The surface is three methods and five tools and will not
grow; tests speak the wire format to a real child process and check each
tool against the CLI's own `--json` output, so the two cannot drift.

### Built for agents to run

TestGuard is meant to be driven by an AI agent, not typed by a person. Three
things make that safe:

- **One source of truth.** `testguard status --json` computes `state` and the
  one `next` action from the claims file, the evidence, the baseline and the
  working tree. Every human rendering — the CLI text, the session-start
  brief, the skill — derives from it, so they cannot disagree. Every command
  accepts `--json`.
- **An installable operating loop.** `testguard init [dir]` writes the
  **agent layer at the git root**, where agent sessions run —
  `.claude/skills/testguard/SKILL.md` (state → action, verdict → the only
  acceptable fix, the two-gate rule for any test the agent writes), the
  `brief --text` session-start hook, an `AGENTS.md` section — and the
  **project layer** (`.gitignore` lines) beside the claims file. A second
  project in the same repository adds a hook line and an `AGENTS.md`
  bullet; `--here` keeps everything in the subdirectory. The hook
  resolves the project's `node_modules/.bin/testguard`, then the git root's,
  then a `testguard` on `PATH` via `command -v`, then does nothing — **no
  `npx` in any form, so no path to the network**; a pre-0.6 `npx -y` or
  `npx --no-install` hook is replaced. A written file that
  `.gitignore` swallows is reported, not offered for commit. Idempotent.
- **Independence is recorded (L3).** `probe` measures *power* — would this
  test notice if the code were wrong. It also records, on every kill, whether
  the killing test was last touched by the same change (or the same author) as
  the code it guards: `detail.independence` is `co-authored`,
  `separate-change` or `unknown`. A co-authored kill is legitimate — a fix
  *should* ship with its regression test — but a repository where every kill
  is co-authored has no independent verification, whatever its claim
  verification rate says. It is a **signal**: ranking reads it, verdicts never
  do, and the brief says it in one line. Nothing else in this category
  measures it, and agents saturate the tests they can see
  ([SpecBench](https://arxiv.org/abs/2605.21384)).
- **Gaming is visible.** The cheapest way to make a survivor disappear is to
  weaken its fault, not to write a test. Evidence records every fault's
  content hash; `status` lists any fault edited after it survived, with its
  previous verdict, and makes reviewing that edit the next action. Editing a
  claim is allowed — claims can be wrong — but it is never invisible.

### Watching a probe that is still running

A probe runs the defenders N times clean and N times per fault, which takes
minutes. It used to print its stage line only when `stderr` was a terminal —
so CI, a redirected log and an agent harness saw **nothing at all** for the
whole run, which is indistinguishable from a hang. A gate you cannot tell
from a hang is a gate people start killing.

The rewriting is a rendering choice, not a reason to withhold the
information:

| `--progress` | What you get |
|---|---|
| `auto` (default) | `tty` at a terminal, `plain` everywhere else |
| `tty` | one line, rewritten in place — for a human watching |
| `plain` | one append-only line per stage — a log file, CI, an agent |
| `ndjson` | one JSON object per line, stages **and** verdicts as they land |
| `none` | silence |

```bash
npx testguard-cli probe . > probe.log 2>&1          # now reports; used to be silent
npx testguard-cli probe . --progress ndjson 2>events.ndjson
```

```
{"event":"stage","claim":"TG-COST-NAMES-SHARED-DEFENDERS","fault":"F1","stage":"baseline","run":1,"of":3,"at":"…"}
{"event":"verdict","claim":"TG-COST-NAMES-SHARED-DEFENDERS","fault":"F1","verdict":"killed","severity":"medium","file":"src/probe/cost.mjs","at":"…"}
```

**Progress always goes to stderr**, so `--json` leaves stdout as one document
and nothing else. `--quiet` and `--json` imply `none`, and an explicit
`--progress` overrides both: an operator who asks for a stream of events has
said what they want.

### What the probe costs, and why a gate gets slow

A probe's wall clock is not a function of how many claims you have. Per claim
it is roughly

```
(baseline runs + faults × --confirm) × the cost of that claim's defender SET
```

so one slow acceptance test, named as a defender by five claims, is paid for
thirty times. The symptom is a gate that takes twenty minutes; the cause is a
single line in the claims file, and nothing in the output used to say which.

```bash
npx testguard-cli claims . --cost     # read back from the last probe's evidence
npx testguard-cli probe . --cost      # what the run you just made spent
```

```
63 fault records cost 24m across 378 defender runs.

most expensive claims
    4m 58s  TG-FAULT-EDIT-VISIBLE              1 fault  · 6 runs

defender files, by the time of the runs that included them
  (a claim runs its whole defender set at once, so these overlap and do not sum to the total)
    24m 3s  test/probe.fixture.test.mjs                  5 claims

shared defenders — each claim pays the file's full cost again
    24m 3s  test/probe.fixture.test.mjs
            named by TG-ESCALATION-N-RUNS, TG-FAULT-EDIT-VISIBLE, …
```

Every number is read back out of the `durationMs` the probe already records.
`--cost` re-measures nothing, spawns nothing, and costs the price of reading
one JSON file.

**The per-file figures overlap.** A run executes a claim's whole defender set
at once, so the runner never says how much of it belonged to which file. A
file's `ms` is the time of every run that *included* it: an upper bound on
what removing it could save, which is the decision you are making. Only
`totalMs` is additive.

**What to do about a shared defender.** Extract the decision it proves into a
pure function, unit-test that, and point the claim at the unit test. This is
not a testing trick — it is the same reason `classify()` in this codebase is
pure. A rule you can state in three lines should not need a fifty-second
acceptance test to falsify it. When the extraction is right the claim still
fails on the fault; when it is wrong the claim SURVIVES, and the probe tells
you so before you have shipped a weaker gate. Do not narrow `defendedBy` and
assume — re-probe the claim and read the verdict.

### Authoring faults mechanically

Writing faults by hand means reading the code to find exact anchors. Two
field reports found that ~80% of hand-written faults are one of nine shapes,
so `scaffold` proposes them for you:

```bash
npx testguard-cli scaffold src/auth.ts          # → .testguard/scaffold-auth.json (a draft, never your claims file)
npx testguard-cli scaffold src/auth.ts --claim AUTH-ADMIN   # every proposal under one claim; copies it if it exists
```

| Shape | What it proposes |
|---|---|
| `condition-forced` | `if (<guard>) {` → `if (false) {` — a guard is a `!…` condition or one whose body returns, throws or 4xx-es |
| `statement-deleted` | a single-line guard (`if (…) return …;`) or a state change (`x = …;`) removed |
| `return-altered` | `return <check>;` (`===`, `.includes(`, `&&`, …) → `return true;` |
| `literal-changed` | `httpOnly`/`secure` flipped, `sameSite` → `none`, a cost/rounds → `1`, a ttl/tolerance/window/limit ×1000 |
| `call-removed` | a bare `verify…()` / `validate…()` / `check…()` / `authorize…()` call removed |
| `field-dropped` | a field removed from an object that is returned, built by an arrow, assigned to a payload-ish name, passed to a `save`/`update`/`send`/`write`/… call, or is a `z.object({…})`-style schema; a string entry removed from an allow-list array; a `...base,` line or inline `{ ...base, … }` merge dropped. Only a line that can go on its own (balanced, comma-terminated or followed by the closer); never inside tests, fixtures or migrations |
| `argument-swapped` | a call kept, its first argument swapped for `undefined` (and `{}` when the argument is itself a call) — only when that argument is derived from a parameter of the enclosing function or a request-like value (`req`, `ctx`, `event`, …). The seam fault: `decide(deriveFrom(input), now)` → `decide(undefined, now)` |
| `element-removed` | a one-line JSX element — self-closing (`<Toggle … />`) or paired (`<button …>Save</button>`) — removed; the UI shape behind "the toggle is invisible", killable by a browser-layer defender |
| `handler-dropped` | an `on<Event>={…}` prop removed, whether it is its own line or inline in the tag; the control renders and does nothing |

Every proposal's `find` is the exact line with `expectHits`/`occurrence`
computed from the file, so it is verifiable by construction; provenance is
`producer: derived`; `defendedBy` is prefilled from the tests that import
the module; proposals are grouped under a preceding `@claim <ID>` annotation
or by enclosing function. Statements are `TODO:` placeholders — a proposal
becomes a claim only when a human states what it defends. Deterministic
heuristics, no AST, no LLM; a proposal the tool cannot anchor is never
emitted.

**Commit `.testguard/baseline.json`; ignore `evidence.json` and `brief.json`.**
The baseline is the frozen contract; the other two are regenerated per run.

The fault model is the auditable artifact. You never reach 100% of
correctness; you reach **100% of stated claims verified**, and the statement
of claims is what an assessor reads. A claims file is code — its `replace`
strings run under your test runner — so review it like code.

## Try it

The repository ships a known-answer fixture with a real blind spot:

```bash
git clone <this repo> && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` is a tiny project whose audit-row test asserts with
`expect.objectContaining({...})` and omits the `content` key. Swap the
redacted text for the raw input and the test stays green. `probe` reports it
as `SURVIVED`; the fixture's [README](fixtures/known-answer/README.md) walks
through every verdict.

## Status

**v0.5.** Eleven commands (`status`, `init`, `claims`, `probe`, `admit`, `replay`, `baseline`, `brief`, `gate`, `scaffold`, `mcp`), vitest and jest runners, hand-authored faults plus
**v0.5.** Nine commands (`status`, `init`, `claims`, `probe`, `admit`, `baseline`, `brief`, `gate`, `scaffold`), vitest, jest and Playwright runners, hand-authored faults plus
a mechanical scaffold, an agent operating layer (`status`, `init`) and a
change gate (`gate`). The contract
spine — eight JSON Schemas shared with the other Guard tools — is under
[`spec/`](spec/). One exact-pinned runtime dependency (`ajv`, for schema validation); Node ≥ 20.

Not yet: test generation (the acceptance half, `admit`, exists; the generating half stays the agent's), runners beyond
vitest and jest, AST-aware producers, and the transfer of a calibration between repositories — `replay` measures it
now; whether it carries to a repository with no history is unproven. Each is
designed for; none is claimed.
vitest, jest and Playwright, AST-aware producers, and calibration of fault classes
against real escaped bugs. Each is designed for; none is claimed.

## Licence

MIT.
