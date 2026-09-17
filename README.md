# TestGuard

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](./package.json)

> Proves that a test suite actually defends the claims a project makes — by
> injecting the faults those claims say cannot happen, and reporting every
> fault the tests fail to detect.

**Not a test generator. A claim verifier.** Test generation is what happens
after a claim turns out to be unfalsifiable.

Third tool following the Guard pattern, alongside
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ code) and
[`websec-validator`](https://pypi.org/project/websec-validator/) (attack
surface ↔ code). All three run one loop:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

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
| GitHub Action | `uses: raccioly/testguard@v0.5.0` — see [`action.yml`](./action.yml) |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-probe` |

Projects that set `min-release-age` in `.npmrc` cannot see a version published
less than that many days ago (`ENOVERSIONS`); install that one with
`npm i -D testguard-cli --min-release-age=0`.

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
   N-run attribution, restores, and classifies. Verdicts are a closed set:

   | Verdict | Meaning |
   |---|---|
   | `killed` | a test body rejected the behaviour, N/N — the only pass |
   | `SURVIVED` | the defenders stayed green while the claim was false |
   | `NOCOVER` | no test file defends the claim at all |
   | `UNVERIFIABLE` | the fault's anchor is missing or ambiguous — loud, never a skip |
   | `TIMEOUT` | the defenders hung; a hang is not a detection |
   | `FAULT-INVALID` | the replacement does not load — a bad fault, not a finding |
   | `FLAKY-DEFENDER` | the defenders are not reliably green, or disagreed across runs |

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
   files that import the fault's target, by relative path or resolved alias.
   `NOCOVER` then means exactly "no test file imports this source".

   Runners: **vitest** and **jest** (`--runner auto` picks the first that
   resolves; both read the same jest-compatible JSON report). Anything else
   goes through `--runner-cmd`. Each runner is proven against its own copy
   of the known-answer fixture.

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
   in CI costs only what changed.
4. **Brief** turns evidence plus baseline into a ranked, capped
   `## TEST BLINDSPOT CONTEXT` block, printed and also written to
   `.testguard/brief.json` (`--text` prints only). Wire it into an agent's session start
   — for Claude Code, in `.claude/settings.json`:

   ```json
   { "hooks": { "SessionStart": [ { "hooks": [
     { "type": "command", "command": "npx testguard-cli brief --text" }
   ] } ] } }
   ```

   `--text` prints only, and exits 0 silently when there is no evidence yet,
   so the hook can never break a session.

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
- uses: raccioly/testguard@v0.5.0
  with: { command: gate }

# GitLab CI — or include: remote: the template in packaging/gitlab/
testguard:gate:
  image: node:22
  rules: [{ if: $CI_PIPELINE_SOURCE == "merge_request_event" }]
  script: [npx -y testguard-cli gate .]
```

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

### Built for agents to run

TestGuard is meant to be driven by an AI agent, not typed by a person. Three
things make that safe:

- **One source of truth.** `testguard status --json` computes `state` and the
  one `next` action from the claims file, the evidence, the baseline and the
  working tree. Every human rendering — the CLI text, the session-start
  brief, the skill — derives from it, so they cannot disagree. Every command
  accepts `--json`.
- **An installable operating loop.** `testguard init` writes
  `.claude/skills/testguard/SKILL.md` (state → action, verdict → the only
  acceptable fix, the two-gate rule for any test the agent writes), the
  `brief --text` session-start hook, an `AGENTS.md` section and the
  `.gitignore` lines. Idempotent.
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

### Authoring faults mechanically

Writing faults by hand means reading the code to find exact anchors. Two
field reports found that ~80% of hand-written faults are one of seven shapes,
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

**v0.5.** Nine commands (`status`, `init`, `claims`, `probe`, `admit`, `baseline`, `brief`, `gate`, `scaffold`), vitest and jest runners, hand-authored faults plus
a mechanical scaffold, an agent operating layer (`status`, `init`) and a
change gate (`gate`). The contract
spine — eight JSON Schemas shared with the other Guard tools — is under
[`spec/`](spec/). One exact-pinned runtime dependency (`ajv`, for schema validation); Node ≥ 20.

Not yet: test generation (the acceptance half, `admit`, exists; the generating half stays the agent's), runners beyond
vitest and jest, AST-aware producers, and calibration of fault classes
against real escaped bugs. Each is designed for; none is claimed.

## Licence

MIT.
