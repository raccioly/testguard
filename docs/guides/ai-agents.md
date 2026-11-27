# Using TestGuard with your AI agent

An AI agent is meant to drive TestGuard. A person is not meant to type the
commands. This guide is for the developer who sets that up. It covers what
`init` installs for each harness, the exact session-start hook, the operating
loop that the agent follows, and prompts that you can paste to get started. An
agent that writes both the code and its tests encodes what it believed, bugs
included, and the suite goes green. TestGuard is the check that does not share
those beliefs.

## Setup by harness

| Harness | What `init` gives it | What else to do |
|---|---|---|
| **Claude Code** | the skill at `.claude/skills/testguard/SKILL.md`, a `SessionStart` hook in `.claude/settings.json`, and a TestGuard section in `AGENTS.md` | nothing; commit the files. You can also add the MCP server. |
| **Codex** | the `AGENTS.md` section, which Codex reads and which points at the skill file for the full loop | `init` writes nothing under `.codex/`. For MCP, add the snippet that `init --mcp` prints for `~/.codex/config.toml`. |
| **Cursor** | the `AGENTS.md` section and the skill file, as plain Markdown | add the snippet that `init --mcp` prints for `.cursor/mcp.json`. If your setup does not load `AGENTS.md`, paste that section into the rules of the harness. |
| **Any other harness** | the same files | have the agent run `testguard status --json` and do what `next.command` says. That one call is the whole interface. |

Every harness uses the same source of truth. `status --json` computes the
state of the project and the one next action from the claims file, the
evidence, the baseline and the working tree. The CLI text, the brief and the
skill all come from it, so they cannot disagree.

## Install the agent layer

```bash
npx testguard-cli init          # agent layer at the git root, project layer here
```

```text
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ .gitignore: 12 lines added

Agents now start with the blind-spot brief and can run `testguard status --json` to learn what to do next. The hook prefers a local install and never fetches from the network.
Commit these files.
```

`init` writes two layers to two places:

- The **agent layer** (skill, hook, `AGENTS.md` section) goes to the **git
  root**, because an agent session runs there. An agent never reads an agent
  layer that you install in a subdirectory.
- The **project layer** (the `.gitignore` lines for the regenerated
  `.testguard/` files) goes beside the claims file.

A second project in the same repository (`init backend`) adds one hook entry
and one `AGENTS.md` bullet, never a duplicate. `--here` keeps everything in the
subdirectory when that subdirectory is its own agent root. `init` is
idempotent. If `.gitignore` ignores a file that `init` wrote, `init` says so
and exits `1`, because an agent in a fresh clone would never see that file.

An ordinary `init` never overwrites an existing skill or an `AGENTS.md`
section that already lists the project. `--force` replaces the skill file
(and, with `--ci-evidence`, the helper script) but does not refresh an
`AGENTS.md` section. Use `--force` with approval and review the diff. An
upgrade of the package does not refresh a copied skill. See
[upgrading](../upgrade.md).

## The session-start hook

`init` adds this to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true"
          }
        ]
      }
    ]
  }
}
```

For a nested project such as `backend/`, the entry that `init` adds checks the
install of the project first, then the install at the root:

```json
{
  "type": "command",
  "command": "backend/node_modules/.bin/testguard brief --text backend 2>/dev/null || node_modules/.bin/testguard brief --text backend 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text backend 2>/dev/null; } || true"
}
```

The hook has this shape for these reasons:

- It uses the installed binary of the project first, then a `testguard` on
  `PATH`, and then does nothing. It ends in `true`, so it can never break a
  session.
- It never reaches the network. It has no package-runner fallback in any form.
  A package runner that declines to install still resolves the package from the
  registry first. When you run `init` again, it replaces any earlier TestGuard
  hook in place, whichever release wrote it. So a session never briefs twice.
- `brief --text` only prints. It exits `0` silently when there is no evidence
  yet. The brief names the install that answered (`local install`,
  `npx cache`, `pnpm dlx cache`, `bunx cache` or `global`). So you can see a
  stale binary, global or cached.

For other harnesses that have a session-start mechanism, the same command works
unchanged.

## The operating loop

Between those steps, the agent follows the fast loop. These are the commands:

```bash
testguard probe --changed auto              # after changing code
testguard probe --claim <ID> --confirm 1    # while writing one test (provisional)
testguard admit <test-file> --claim <ID>    # before committing that test
testguard probe                             # the full probe: only when asked, or nightly
```

Faults already run in parallel, and a run alone confirms every kill. So the
agent never passes `--serial` unless a suite cannot share the machine.
`status` and the brief carry `advice` lines when a run wastes time. Each line
has the command to run.

The skill teaches one loop. The agent never infers the state from the files
that exist. It asks:

```bash
testguard status --json
```

and acts on `state` and `next`:

| `state` | Meaning | The agent does |
|---|---|---|
| `no-claims` | no claims file, or an empty one | `testguard scaffold <file>` on a file with guards; replace every `TODO:` statement with intent from a spec, ticket or past bug; keep or drop each proposal; move the claims into `testguard.claims.json` |
| `unclaimed-changes` | changed source files carry no claim (computed when a base reference is known) | state the claim for `next.file` (or add an ignore entry with a reason) **before writing more code** |
| `invalid-anchors` | an exact fault anchor moved or became ambiguous | `testguard claims --check-anchors`, then repair `next.target` without changing what the fault means, and re-probe |
| `unprobed` | claims that were never probed | `testguard probe` |
| `evidence-stale` | code, tests, claims or a fault changed since the evidence | `next.command` (or review the fault edit `next` names); in the inner loop, `testguard probe --changed auto --include-dirty` |
| `provisional-only` | only `--confirm 1` evidence exists | `testguard probe --confirm 3` |
| `unproven` | a finding not covered by the baseline | `next.target` names it; apply the verdict's fix below |
| `clean` | everything killed or baselined | `testguard baseline` if `next` says so; otherwise nothing, or expand the claimed surface when `next` points at an unclaimed module |

`next.action` is one of `scaffold`, `claim`, `probe`, `write-test`,
`baseline`, `review-fault-change`, `repair-fault` or `none`. `next.command` is
the shell line to follow (for `write-test`, it is the instruction). `status`
exits `0` when clean. It exits `1` when something is unproven, stale,
unclaimed or has an invalid anchor. It exits `2` when there is nothing to probe
yet. The shape of the document is
[`status.schema.json`](../../spec/schemas/status.schema.json).

This is a real `unproven` result, from the audit-log example in
[Writing claims](writing-claims.md#2-an-audit-log-field-survived-then-fixed):

```json
{
  "action": "write-test",
  "command": "write a test in test/audit.test.mjs that fails on AUDIT-ACTOR-001/F1 and passes on HEAD, then: testguard admit test/audit.test.mjs --claim AUDIT-ACTOR-001",
  "why": "AUDIT-ACTOR-001/F1 (high) survived: \"Every audit row records the id of the actor who performed the action.\" can be false with the suite green.",
  "target": { "claimId": "AUDIT-ACTOR-001", "subjectId": "F1", "file": "src/audit.mjs", "verdict": "survived" }
}
```

### Verdict → the only acceptable fix

| Verdict | The fix |
|---|---|
| `SURVIVED` | write a test in the defender file that fails with the fault applied and passes on `HEAD` |
| `SURVIVED [killed-by-undeclared-tests: …]` | add those test files to the claim's `defendedBy` |
| `NOCOVER` | write a new test file that imports the target and asserts the claim |
| `UNVERIFIABLE` | fix the fault definition (or the import of the defenders), never the code |
| `FAULT-INVALID` | fix the fault definition |
| `TIMEOUT` | write an assertion that fails on it; a hang is not a detection |
| `FLAKY-DEFENDER` | fix the flake first; no verdict is trustworthy until then |

[Verdicts](../reference/verdicts.md) has the full table, with signals.

### The two-gate rule

Every test that the agent writes must pass two gates: **green on unmodified
`HEAD`**, and **red on every fault of the claim**, three runs out of three. One
command checks both gates on the uncommitted test, and it does not touch the
tree:

```bash
testguard admit test/audit.test.mjs --claim AUDIT-ACTOR-001
```

`ADMITTED` (exit `0`) means: commit the test. `NOT ADMITTED` (exit `1`) names
the first blocking fault. `--confirm 1` gives a fast `ADMITTED?`. Confirm it at
3 before you commit. [Writing claims](writing-claims.md#admit-the-two-gate-rule)
has the details.

### Rules the agent does not get to bend

- **Never make a fault die by editing the claims file.** You may edit a claim
  that was wrong. But `status` lists every fault that someone edited after it
  survived, with its previous verdict. Say why in the commit.
- **A test that asserts current behavior is not a fix.** If it would pass with
  the fault applied, it defends nothing.
- **Never re-implement the code under test inside the test.** Drive the real
  function and assert the outcome. A test file that copies the logic and
  asserts against the copy can stay green forever while the real code is
  broken.
- **Every new or changed source file needs a claim.** Run
  `testguard gate --changed HEAD --include-dirty` before you commit. A new test
  file must appear in the `defendedBy` of some claim.
- **`--confirm 1` results are provisional.** They print with `?` and you cannot
  baseline them.
- **Do not commit half-written tests to satisfy a probe.** Use
  `--include-dirty`.
- **Commit `.testguard/baseline.json`. Never commit `evidence.json` or
  `brief.json`.** See [artifacts](../reference/artifacts.md).

## Prompts to paste

These work in any harness after `init` has run.

```text
Adopt TestGuard in this repo following docs/guides/existing-projects.md.
Start with `testguard status --json` and follow `next`. Do not write claims
from the code alone: ask me for the intended behaviour, or point me at the
requirement, ADR or incident it comes from.
```

```text
Write a test that kills SURVIVED claim AUDIT-ACTOR-001 and prove it with
`testguard admit <test-file> --claim AUDIT-ACTOR-001`. Do not edit
testguard.claims.json. Stop when it is ADMITTED at --confirm 3.
```

```text
Before you change src/billing/, run `testguard gate --changed HEAD --include-dirty`.
For every UNCLAIMED file, propose a claim with `testguard scaffold <file>`,
show me the statement and faults, and wait for my approval before adding it.
```

```text
Run `testguard claims --since origin/main` and explain every removed claim
or fault. For each, tell me whether it was SURVIVED when it was removed.
```

## Running it through MCP

When a harness cannot run the skill or the hook, `testguard mcp` serves the
same documents over the Model Context Protocol on stdio. `testguard init --mcp`
prints a ready config for Claude Code, Cursor and Codex. It prints the config
and never writes it, because you place the config of a harness yourself. The
server has five tools. They are read-only, and none runs a probe.
`testguard_next_command` returns the shell line for the agent to run where you
can see it, plus the fast loop (`loop`) and any speed `advice`.
[The MCP reference](../reference/mcp.md) covers the tools and the config.

## CI evidence in a local session

Evidence stays where `probe` ran, and you do not commit it. So on a fresh
clone, the brief is empty and `status` says `unprobed`, even when CI has full
evidence. Point either command at the document from CI:

```bash
testguard status . --evidence .testguard/ci/evidence.json
testguard brief . --text --evidence .testguard/ci/evidence.json
```

TestGuard marks a document that you provide as `evidenceSource: provided`. It
names both commits. It still computes staleness from the recorded input hashes
of the document. So if you edited a file since CI ran, the state goes to
`evidence-stale`. `init --ci-evidence github` (or `gitlab`) writes an on-demand
helper, `.testguard/fetch-ci-evidence.sh`. The helper fetches the artifact with
the platform CLI that you already have. It runs only when you run it.
[GitHub Actions](ci/github-actions.md) and [GitLab](ci/gitlab.md) show where CI
writes that artifact. [Artifacts](../reference/artifacts.md) explains which
file is which.

## Version checks are advice, not installs

The skill and the `AGENTS.md` section ask the agent to compare the CLI that it
actually runs with the latest stable version in the registry. The agent does
this once per session, and only if your network policy permits. The agent then
suggests an upgrade and asks before it changes anything. The CLI and the hook
of TestGuard make no such check. A failed or skipped check changes no verdict,
evidence or exit code. See [upgrading](../upgrade.md).

## Next

- [Writing claims](writing-claims.md): what the agent is asked to write
- [Adopting TestGuard in an existing project](existing-projects.md)
- [Verdicts](../reference/verdicts.md)
- [MCP reference](../reference/mcp.md)
