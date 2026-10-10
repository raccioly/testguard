# Using TestGuard with your AI agent

TestGuard is meant to be driven by an AI agent, not typed by a person. This
guide is for the developer setting that up: what `init` installs for each
harness, the exact session-start hook, the operating loop the agent follows,
and prompts you can paste to get it going. An agent that writes both the code
and its tests encodes whatever it believed, bugs included, and the suite goes
green; TestGuard is the check that does not share those beliefs.

## Setup by harness

| Harness | What `init` gives it | What else to do |
|---|---|---|
| **Claude Code** | the skill at `.claude/skills/testguard/SKILL.md`, a `SessionStart` hook in `.claude/settings.json`, and a TestGuard section in `AGENTS.md` | nothing; commit the files. Optionally add the MCP server. |
| **Codex** | the `AGENTS.md` section, which Codex reads, and which points at the skill file for the full loop | `init` writes nothing under `.codex/`. For MCP, add the snippet `init --mcp` prints for `~/.codex/config.toml`. |
| **Cursor** | the `AGENTS.md` section and the skill file, as plain Markdown | add the snippet `init --mcp` prints for `.cursor/mcp.json`. If your setup does not load `AGENTS.md`, paste that section into the harness's own rules. |
| **Any other harness** | the same files | have the agent run `testguard status --json` and do what `next.command` says. That one call is the whole interface. |

Every harness ends up on the same source of truth: `status --json` computes
the project's state and the one next action from the claims file, the
evidence, the baseline and the working tree. The CLI text, the brief and the
skill all derive from it, so they cannot disagree.

## Install the agent layer

```bash
npx testguard-cli init          # agent layer at the git root, project layer here
```

```text
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ .gitignore: 10 lines added

Agents now start with the blind-spot brief and can run `testguard status --json` to learn what to do next. The hook prefers a local install and never fetches from the network.
Commit these files.
```

`init` writes two layers to two places:

- The **agent layer** (skill, hook, `AGENTS.md` section) goes to the **git
  root**, because that is where an agent session runs. Installed in a
  subdirectory, it would never be read.
- The **project layer** (the `.gitignore` lines for regenerated
  `.testguard/` files) goes beside the claims file.

A second project in the same repository (`init backend`) adds one hook entry
and one `AGENTS.md` bullet, never a duplicate; `--here` keeps everything in the
subdirectory when that subdirectory is its own agent root. `init` is
idempotent. If a file it wrote is ignored by `.gitignore`, it says so and
exits `1`, because an agent in a fresh clone would never see it.

An ordinary `init` never overwrites an existing skill or an `AGENTS.md`
section that already lists the project. `--force` replaces the skill file
(and, with `--ci-evidence`, the helper script) but does not refresh an
`AGENTS.md` section; use it with approval and review the diff. Upgrading the package does not
refresh a copied skill: see [upgrading](../upgrade.md).

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

For a nested project such as `backend/`, the entry it adds checks the
project's own install first, then the root's:

```json
{
  "type": "command",
  "command": "backend/node_modules/.bin/testguard brief --text backend 2>/dev/null || node_modules/.bin/testguard brief --text backend 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text backend 2>/dev/null; } || true"
}
```

Why it is shaped this way:

- It resolves the project's installed binary, then a `testguard` on `PATH`,
  then does nothing. It ends in `true`, so it can never break a session.
- It never reaches the network.
  There is no package-runner fallback in it in any form: one that declines to
  install still resolves the package from the registry first.
  An older hook that used one is replaced when you run `init` again.
- `brief --text` prints only, and exits `0` silently when there is no evidence
  yet. The brief names the install that answered (`local install` or
  `global`), so a stale global binary is visible.

For other harnesses with a session-start mechanism, the same command works
unchanged.

## The operating loop

The skill teaches one loop. The agent never infers state from which files
exist; it asks:

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
| `evidence-stale` | code, tests, claims or a fault changed since the evidence | `testguard probe --include-dirty`, or review the fault edit `next` names |
| `provisional-only` | only `--confirm 1` evidence exists | `testguard probe --confirm 3` |
| `unproven` | a finding not covered by the baseline | `next.target` names it; apply the verdict's fix below |
| `clean` | everything killed or baselined | `testguard baseline` if `next` says so; otherwise nothing, or expand the claimed surface when `next` points at an unclaimed module |

`next.action` is one of `scaffold`, `claim`, `probe`, `write-test`,
`baseline`, `review-fault-change`, `repair-fault` or `none`, and
`next.command` is the shell line (or, for `write-test`, the instruction) to
follow. `status` exits `0` when clean, `1` when something is unproven, stale,
unclaimed or has an invalid anchor, and `2` when there is nothing to probe yet.
The document's shape is [`status.schema.json`](../../spec/schemas/status.schema.json).

A real `unproven` result, from the audit-log example in
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
| `UNVERIFIABLE` | fix the fault definition (or the defenders' import), never the code |
| `FAULT-INVALID` | fix the fault definition |
| `TIMEOUT` | write an assertion that fails on it; a hang is not a detection |
| `FLAKY-DEFENDER` | fix the flake first; no verdict is trustworthy until then |

The full table, with signals, is in [verdicts](../reference/verdicts.md).

### The two-gate rule

Every test the agent writes must pass two gates: **green on unmodified
`HEAD`**, and **red on every fault of the claim**, three runs out of three. One
command checks both, on the uncommitted test, without touching the tree:

```bash
testguard admit test/audit.test.mjs --claim AUDIT-ACTOR-001
```

`ADMITTED` (exit `0`) means commit it. `NOT ADMITTED` (exit `1`) names the
first blocking fault. `--confirm 1` gives a fast `ADMITTED?` that must be
confirmed at 3 before committing. Details are in
[Writing claims](writing-claims.md#admit-the-two-gate-rule).

### Rules the agent does not get to bend

- **Never make a fault die by editing the claims file.** Editing a claim that
  was wrong is allowed, but every fault edited after it survived is listed in
  `status` with its previous verdict. Say why in the commit.
- **A test that asserts current behaviour is not a fix.** If it would pass
  with the fault applied, it defends nothing.
- **Never re-implement the code under test inside the test.** Drive the real
  function and assert the outcome. A test file that copies the logic and
  asserts against the copy can be green forever while the real code is broken.
- **Every new or changed source file needs a claim.** Run
  `testguard gate --changed HEAD --include-dirty` before committing; a new test
  file must appear in some claim's `defendedBy`.
- **`--confirm 1` results are provisional**: they print with `?` and cannot be
  baselined.
- **Do not commit half-written tests to satisfy a probe.** Use
  `--include-dirty`.
- **Commit `.testguard/baseline.json`; never commit `evidence.json` or
  `brief.json`.** See [artifacts](../reference/artifacts.md).

## Prompts to paste

These work in any harness once `init` has run.

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
same documents over the Model Context Protocol on stdio, and
`testguard init --mcp` prints a ready config for Claude Code, Cursor and Codex
(printed, never written: a harness config is yours to place). Its five tools
are read-only, and none runs a probe: `testguard_next_command` returns the
shell line for the agent to run where you can see it. Tools and config are in
[the MCP reference](../reference/mcp.md).

## CI evidence in a local session

Evidence lives where `probe` ran and is not committed, so on a fresh clone the
brief is empty and `status` says `unprobed` even when CI has full evidence.
Point either command at CI's document:

```bash
testguard status . --evidence .testguard/ci/ci-self-evidence.json
testguard brief . --text --evidence .testguard/ci/ci-self-evidence.json
```

A provided document is marked `evidenceSource: provided`, both commits are
named, and staleness is still computed from its recorded input hashes, so a
file you edited since CI ran goes `evidence-stale`.
`init --ci-evidence github` (or `gitlab`) writes an on-demand helper,
`.testguard/fetch-ci-evidence.sh`, that fetches the artifact with the platform
CLI you already have; it runs only when you run it.
Where CI writes that artifact is in [GitHub Actions](ci/github-actions.md) and
[GitLab](ci/gitlab.md); which files are which is in
[artifacts](../reference/artifacts.md).

## Version checks are advice, not installs

The skill and the `AGENTS.md` section ask the agent, once per session and only
if your network policy permits, to compare the CLI it is actually running with
the registry's latest stable version, and to suggest an upgrade and ask before
changing anything. TestGuard's CLI and hook make no such check themselves, and
a failed or skipped check changes no verdict, evidence or exit code. See
[upgrading](../upgrade.md).

## Next

- [Writing claims](writing-claims.md): what the agent is asked to write
- [Adopting TestGuard in an existing project](existing-projects.md)
- [Verdicts](../reference/verdicts.md)
- [MCP reference](../reference/mcp.md)
