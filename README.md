# TestGuard

<!-- docguard:quality negation-load off — this README explains a tool defined by what must not happen; the negations are the product. -->
<!-- docguard:quality passive-voice off — verdicts and artifacts are the subjects throughout ("a fault is applied", "evidence is written"); naming an actor would misdescribe a tool nobody operates interactively. -->

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/raccioly/testguard/blob/main/LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](https://github.com/raccioly/testguard/blob/main/package.json)

**English** · [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md)

> Breaks your code on purpose and reports every promise your tests did not
> notice breaking.

**Not a test generator. A claim verifier.** Test generation comes after a
claim turns out to be unfalsifiable.

TestGuard is the third tool that follows the Guard pattern. The other two are
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ code) and
[`websec-validator`](https://pypi.org/project/websec-validator/) (attack
surface ↔ code). All three run one loop:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

## In one minute

**Coverage tells you a line ran. It never tells you anyone checked the
result.** A codebase can be fully covered and completely undefended. Nothing
in CI tells you.

Here is a real test, from this repository's own fixture:

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` ignores keys it does not list. Swap the redacted text for
the **raw secret** and this test still passes. Coverage of that line is 100%.
The audit log now leaks the data it exists to protect.

**The method: break the code on purpose, then watch what the tests do.**

- **killed** — you broke the code and a test failed. Good. The suite really
  defends that behaviour.
- **SURVIVED** — you broke the code and every test stayed green. This is a
  blind spot.

The word confuses everyone once: it is the *fault* that survived, not the
test. **SURVIVED is the bad news.** A healthy report is full of `killed`.

But *"did the tests fail?"* is not a precise question. A red suite is not
proof of detection. So there are seven verdicts, and each one means something
different:

| Verdict | What it means |
|---|---|
| `killed` | A test body ran and rejected the behaviour. The only good outcome. |
| `SURVIVED` | Everything passed. A real blind spot in the tests. |
| `NOCOVER` | No test even looks at this code. Not "weak tests" — *no* tests. |
| `UNVERIFIABLE` | The fault could not be applied: its anchor moved, or matches twice. Nothing was learned. |
| `FAULT-INVALID` | The break itself was broken — it did not compile. Our fault, not yours. |
| `TIMEOUT` | The suite hung. A hang is not a detection. |
| `FLAKY-DEFENDER` | The tests are not reliable enough on untouched code to be asked the question. |

When a result is unclear, TestGuard treats it as *unproven*. It runs three
times, not once. It needs a green baseline before it injects any fault. A
timeout, a load failure or a mixed result is never a kill. The whole design
follows one rule: **a tool that reports everything as caught is worse than no
tool at all, because nobody questions good news.**

**What is not new:** breaking code to test your tests is *mutation testing*.
It dates to the 1970s. Stryker, PIT, mutmut and Cosmic Ray all do it.

**What is different is the question.** Classic mutation testing mutates
everything mechanically and gives you *"mutation score: 73%"*. That number is
not actionable and not auditable. It cannot tell you which promise is at risk.
TestGuard binds every fault to a **stated claim**. So the output is a finding,
not a score: *"Your project says a missing scope fails closed. Nothing checks
that."* That is the difference between a metric and an audit.

📄 **[Read the six-page technical brief (PDF)](https://github.com/raccioly/testguard/blob/main/docs/testguard-explained.pdf)**
— the idea on page one, then the field evidence, the anatomy of a run, the
verdicts, the loop and its calibration, and the prior art.

## Why

Coverage cannot tell a test that pins *correct* behaviour from a test that
pins a *defect*. An agent that writes both the code and its tests encodes what
it believed, including its bugs. The suite goes green.

On a real, entirely AI-authored production codebase with ~4,900
disciplined tests (no snapshots, 0.4% zero-assertion), **the suite missed 8 of
9 real historical bugs.** In the worst case, 2,451 tests stayed green on
known-broken code. The largest gap was a compliance-critical path with 100%
coverage. The one assertion that mattered used `expect.objectContaining({...})`
and left out the field that carried the data.

A second, independent run used a different AI-authored codebase (63 test
files, 458 tests, 24 hand-written security claims, 39 faults). **21 of 39
faults survived a fully green suite, and 9 of them were critical.** No test
noticed when super-admin gating, membership checks, cookie flags and the
whole authorization callback were disabled. One test file had re-implemented the
authorization logic *inside the test* and asserted against the copy. It gave
fifteen green tests and zero detection. After wrapper-level tests were
written against the survivors, 39/39 faults were killed.

The peer-reviewed research in 2026 says the same thing from the other side.
Coverage and mutation score of LLM-generated suites track effectiveness only
when the code under test is assumed correct. Once the code may be buggy, they
"no longer serve as reliable indicators" ([Zhao, Zhou and Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)).
Buggy code steers a model toward tests that assert the bug. Prompting with the
specification is the mitigation that works ([arXiv 2607.22883](https://arxiv.org/abs/2607.22883)).
So in TestGuard, a claim comes from intent, a fault is bound to the claim, and
the brief gives the agent the claim before it writes. Also, agents saturate
whatever tests they can see. The gap to held-out tests grows about 28 points
per tenfold increase in code size ([SpecBench](https://arxiv.org/abs/2605.21384)).
Every generator on the market admits a test because it compiles, passes and
raises coverage. TestGuard admits a test because it fails when the claim is
false.

## Install

| How | Command |
|---|---|
| npx (no install) | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli` then `npx testguard probe` |
| pip | `pip install testguard-cli` then `testguard probe` (needs Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.26.3` |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-gate`, `testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.26.3/packaging/gitlab/testguard.gitlab-ci.yml` |

The [installation guide](https://github.com/raccioly/testguard/blob/main/docs/installation.md)
covers requirements, offline installs, `ENOVERSIONS` and every CI option.

## Make it fast

```bash
testguard probe --changed auto                 # after a change: only the claims it can affect
testguard probe --claim <ID> --confirm 1       # while writing one test: fast, provisional
testguard probe                                # nightly, or when asked: every claim
```

- Faults already run in parallel: half the CPUs, at most 4 (`--serial` runs one at a time).
- A run on its own confirms every kill. So a suite that shares a port or a database cannot fake a kill.
- TestGuard reuses unchanged verdicts. A `--changed` or `--claim` run reuses the last full probe.
- `testguard init` writes a pre-push hook that runs the first command. `init --ci github|gitlab` writes a CI job that runs it on pull requests and runs the full probe nightly.

Still slow? `testguard status` prints `advice` with the command to run.
The checklist is [why is this slow?](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md#why-is-this-slow).

## Quickstart

```bash
npx testguard-cli init                      # install the agent layer at the git root
npx testguard-cli status --json             # where the project is, and the ONE next action
npx testguard-cli scaffold src/auth.ts      # propose faults for a file, as a draft to keep or drop
npx testguard-cli claims --check-anchors    # every claim is probeable before anything runs
npx testguard-cli probe                     # try to falsify each claim; report what the tests missed
npx testguard-cli admit test/auth.test.ts --claim AUTH-ADMIN   # does this test fail when the claim is false?
npx testguard-cli baseline                  # freeze today's unproven findings; only new ones gate
npx testguard-cli gate --changed origin/main # fail when a changed source file carries no claim
npx testguard-cli sweep --changed origin/main # no claims yet? report what nothing noticed in the changed files
npx testguard-cli brief --text              # tell the agent where the suite is blind, before it writes
npx testguard-cli replay --since HEAD~50..HEAD # would this suite have caught the bugs that escaped?
```

Exit codes are the contract: `0` nothing new to prove, `1` unproven claims,
unclaimed changes or invalid fault anchors, `2` a precondition failed and
nothing was probed, `3` usage. Every command except `mcp` accepts `--json`.

The [quickstart](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)
walks through a first claim from start to end. A codebase that already has a
large suite has its own guide:
[adopting TestGuard in an existing project](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md).

## Languages and test runners

| Language | Runners | Faults proposed by `scaffold` |
|---|---|---|
| JavaScript | vitest, jest, Playwright, Node's built-in test runner | seven shapes: forced guards, deleted statements, altered returns, weakened literals, removed calls, dropped payload fields, swapped arguments |
| TypeScript | vitest, jest, Playwright (through the project's own transform) | the same seven |
| JSX, TSX (UI) | vitest, jest, Playwright | the seven, plus removed elements and dropped event handlers |
| Python ≥ 3.8 | pytest, or stdlib `unittest` when pytest is absent | the same seven, in Python syntax |
| Anything else | `--runner-cmd` with a jest-compatible JSON report | hand-written faults |

A vitest test and a pytest test can defend one claim at the same time. The
[languages and runners reference](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md)
covers runner resolution, discovery, mocks and limits.

Your tests may need runner flags (`--runner unittest --python .venv/bin/python`,
a `--runner-cmd`, a `--node-modules`). Commit them once in
`testguard.config.json`. Then every hook, CI line and agent can run plain
`testguard probe`:

```json
{ "schemaVersion": 1, "runner": "unittest", "python": ".venv/bin/python" }
```

A flag you type wins over the file. `TESTGUARD_PYTHON`-style variables also win
over it. `--no-config` ignores the file. The keys and rules are in the
[configuration reference](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md#testguardconfigjson-how-this-projects-tests-run).

## Use it with your AI agent

An agent is meant to drive TestGuard. `testguard init` installs three things:
a skill that teaches the operating loop, an `AGENTS.md` section, and a
session-start hook. The hook gives every session the ranked blind spots before
the agent writes code. For Claude Code, the hook in `.claude/settings.json` is:

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
] } ] } }
```

The hook uses the project's own install first. If there is none, it uses a
`testguard` on `PATH`. It ends in `true`, so it can never break a session or
reach the network. Any other harness can use `testguard mcp` (five read-only
tools over stdio) or `testguard status --json`. Setup for Claude Code, Codex,
Cursor and others is in the
[AI agents guide](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md).

## Documentation

| | |
|---|---|
| **Get started** | [Quickstart](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md) · [Installation](https://github.com/raccioly/testguard/blob/main/docs/installation.md) · [Upgrading](https://github.com/raccioly/testguard/blob/main/docs/upgrade.md) |
| **Guides** | [Existing projects](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md) · [New projects](https://github.com/raccioly/testguard/blob/main/docs/guides/new-projects.md) · [Writing claims](https://github.com/raccioly/testguard/blob/main/docs/guides/writing-claims.md) · [AI agents](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md) · [Python](https://github.com/raccioly/testguard/blob/main/docs/guides/python.md) · [Monorepos](https://github.com/raccioly/testguard/blob/main/docs/guides/monorepo.md) · [Performance](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md) · [Replaying escaped bugs](https://github.com/raccioly/testguard/blob/main/docs/guides/replay.md) |
| **CI** | [GitHub Actions](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/github-actions.md) · [GitLab CI](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/gitlab.md) · [pre-commit](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/pre-commit.md) |
| **Reference** | [CLI](https://github.com/raccioly/testguard/blob/main/docs/reference/cli.md) · [Languages and runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md) · [Configuration](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md) · [Verdicts](https://github.com/raccioly/testguard/blob/main/docs/reference/verdicts.md) · [Artifacts](https://github.com/raccioly/testguard/blob/main/docs/reference/artifacts.md) · [MCP](https://github.com/raccioly/testguard/blob/main/docs/reference/mcp.md) · [Gate semantics](https://github.com/raccioly/testguard/blob/main/spec/GATE-SEMANTICS.md) |
| **Understand** | [How it works](https://github.com/raccioly/testguard/blob/main/docs/concepts/how-it-works.md) · [Glossary](https://github.com/raccioly/testguard/blob/main/docs/glossary.md) · [FAQ](https://github.com/raccioly/testguard/blob/main/docs/faq.md) · [Troubleshooting](https://github.com/raccioly/testguard/blob/main/docs/troubleshooting.md) · [Prior art](https://github.com/raccioly/testguard/blob/main/docs-canonical/PRIOR-ART.md) |
| **Translations** | [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md) |

## What TestGuard is not

- **Not a test generator.** It judges a test the agent wrote (`admit`). The
  agent still generates the tests.
- **Not a mutation-score dashboard.** It has no blanket mutants, no single
  score and no threshold. Faults are few and bound to stated claims. TestGuard
  ranks findings and never sums them.
- **Not a coverage tool.** An executed line says nothing about whether an
  assertion would notice. `NOCOVER` here means no test even imports the file.
- **Not a network client.** The CLI never opens a socket and collects no
  telemetry. It has one exact-pinned runtime dependency (`ajv`), needs Node ≥ 20, and uses the MIT license.

## Try it

The repository ships a known-answer fixture with a real blind spot:

```bash
git clone https://github.com/raccioly/testguard && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` is a tiny project. Its audit-row test asserts with
`expect.objectContaining({...})` and omits the `content` key. Swap the
redacted text for the raw input and the test stays green. `probe` reports the
fault as `SURVIVED`. The fixture's [README](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer/README.md)
walks through every verdict. The same blind spot in Python is in
[`fixtures/known-answer-python/`](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer-python/README.md),
It runs under both stdlib `unittest` and `pytest`. They must agree on every
verdict.

## Status

Fourteen commands (`status`, `init`, `claims`, `probe`, `admit`, `baseline`,
`brief`, `gate`, `scaffold`, `sweep`, `concerns`, `replay`, `clean`, `mcp`). Runners
for vitest, jest, Playwright, Node's built-in test runner, pytest and stdlib
`unittest`, plus `--runner-cmd` for anything that writes a jest-compatible
report. Hand-authored faults, and a mechanical scaffold for JavaScript,
TypeScript and Python. The contract is fourteen JSON Schemas under
[`spec/`](https://github.com/raccioly/testguard/blob/main/spec/README.md),
shared with the other Guard tools. Every release is in the
[changelog](https://github.com/raccioly/testguard/blob/main/CHANGELOG.md).

Not yet: test generation (`admit`, the acceptance half, exists; the agent
still does the generating half), AST-aware producers, and the transfer of a
calibration between repositories. `replay` measures that transfer now. Whether
it carries to a repository with no history is unproven. We designed for each
of these, and we claim none of them.

## Contributing

We welcome bug reports, field reports and documentation fixes. First read
[CONTRIBUTING.md](https://github.com/raccioly/testguard/blob/main/CONTRIBUTING.md)
and [AGENTS.md](https://github.com/raccioly/testguard/blob/main/AGENTS.md).
For help, see [SUPPORT.md](https://github.com/raccioly/testguard/blob/main/SUPPORT.md).
Report vulnerabilities privately, as described in
[SECURITY.md](https://github.com/raccioly/testguard/blob/main/SECURITY.md).

## Licence

MIT.
