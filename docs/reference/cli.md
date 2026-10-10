# CLI reference

Every TestGuard command, every flag it reads, what it writes and how it exits.
This page is for looking things up; the guides explain when to reach for each
command. Flags are taken from the CLI's own parser (`src/cli.mjs`) and the
command modules (`src/commands/*.mjs`), including the ones the top-level
`--help` does not print.

```bash
npx testguard-cli --help              # the overview
npx testguard-cli probe --help        # one command's options
npx testguard-cli --version           # the installed version
```

## Global flags

| Flag | Meaning |
|---|---|
| `--json` | Print a machine-readable document instead of text. Every command except `mcp` accepts it; `mcp` refuses it (exit `3`), because anything printed on stdout would corrupt the protocol stream. |
| `--help`, `-h` | Print help. With a command, that command's options; without one, the overview. |
| `--version`, `-v` | Print the version and exit `0`. |

Two flags are validated for every command, whether or not that command uses
them: `--runner` must be one of the runner names below or `auto`, and
`--severity` must be `critical`, `high`, `medium` or `low`. An unknown flag,
an unknown command, or no command at all exits `3`.

Commands that take `[dir]` treat it as the project directory, the one that
holds `testguard.claims.json`; it defaults to the current directory. `scaffold`
and `admit` take a file instead and resolve the project differently (see
their sections).

## Exit codes

The exit code is the contract. Integrations read it; they never parse text.

| Code | Meaning |
|---|---|
| `0` | Nothing new to prove. |
| `1` | A finding: unproven claims, claim drift, unclaimed changes or invalid fault anchors. |
| `2` | A precondition failed and nothing was measured: an invalid claims file, a runner that does not resolve, a reference that does not resolve, missing evidence, an exhausted `--command-budget`. |
| `3` | Usage: a missing or malformed option, an unknown command or flag. |

A command that crashes on a defect in TestGuard itself prints
`error: this is a bug in testguard <version>, not a problem with your project.`
with a stack trace, and exits `2`. Each command's own section below says which
of these codes it can return; the normative rules are in
[`spec/GATE-SEMANTICS.md`](../../spec/GATE-SEMANTICS.md#exit-codes).

## Commands

| Command | One line |
|---|---|
| [`status`](#status) | Where the project is and the one next action. |
| [`init`](#init) | Install the agent layer and the `.gitignore` lines. |
| [`claims`](#claims) | List claims and drift; check anchors; report removed claims; cost; annotation placement. |
| [`probe`](#probe) | Inject each claim's faults, run the defenders, report what survived. |
| [`baseline`](#baseline) | Freeze today's unproven findings so only new ones gate. |
| [`brief`](#brief) | The blind-spot block for an agent's session start. |
| [`gate`](#gate) | Fail when a changed source file carries no claim and no excusing ignore entry. |
| [`scaffold`](#scaffold) | Propose faults mechanically for a source file, as a draft. |
| [`sweep`](#sweep) | Propose and probe faults for unclaimed changed files, with no claims needed. |
| [`concerns`](#concerns) | List the scopes a sweep can be aimed by. |
| [`mcp`](#mcp) | Serve the read-only loop over the Model Context Protocol on stdio. |
| [`replay`](#replay) | Would this suite have caught the bugs that already escaped? |
| [`admit`](#admit) | Is this test green on HEAD and does it fail on every fault of the claim? |

## status

```bash
npx testguard-cli status [dir] [--json] [--changed <ref>] [--include-dirty] [--evidence <path>]
```

Computes the project's state from the claims file, the evidence, the baseline
and the working tree, and names the one next action. It is the single source
of truth: the CLI text, the brief, the skill and the MCP tools all derive from
the same document, so they cannot disagree. It writes nothing.

| Flag | Default | Meaning |
|---|---|---|
| `--json` | off | Print the status document. |
| `--changed <ref>` | detected (see [gate](#gate)) | Also compute claim coverage of the change since `merge-base(ref, HEAD)`. `unclaimed-changes` then precedes every evidence state. An explicit reference that does not resolve is an error; a detected one that does not resolve prints a warning and status continues without it. |
| `--include-dirty` | off | With a reference, compare the working tree (staged, unstaged and untracked) instead of HEAD. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Read this evidence instead, for example CI's, fetched as an artifact. Staleness is still computed from the recorded input hashes, and both commits are named. |

| State | Exit |
|---|---|
| `clean` | `0` |
| `no-claims`, `unprobed` | `2` |
| `unclaimed-changes`, `invalid-anchors`, `evidence-stale`, `provisional-only`, `unproven` | `1` |

`next.action` is one of `scaffold`, `claim`, `probe`, `write-test`,
`baseline`, `review-fault-change`, `repair-fault`, `none`, and `next.command`
is the exact shell line to run.

**`--json` schema:** [`status.schema.json`](../../spec/schemas/status.schema.json).

## init

```bash
npx testguard-cli init [dir] [--here] [--force] [--ci-evidence github|gitlab] [--mcp] [--json]
```

Installs two layers. The **agent layer** goes to the git root, where agent
sessions run: `.claude/skills/testguard/SKILL.md`, a SessionStart hook in
`.claude/settings.json` that runs `brief --text`, and a TestGuard section in
`AGENTS.md`. The **project layer** (the `.gitignore` lines for regenerated
outputs) goes in `[dir]`. It is idempotent: a second project in the same
repository adds a hook line and an `AGENTS.md` bullet, never a duplicate. The
hook prefers a local install, then a `testguard` on `PATH`, then does nothing;
it never reaches the network.

| Flag | Default | Meaning |
|---|---|---|
| `--here` | off | Keep the agent layer in `[dir]` instead of the git root, for a subdirectory that is its own agent root. |
| `--force` | off | Replace an existing skill file (and an existing `.testguard/fetch-ci-evidence.sh`). It does not refresh an `AGENTS.md` section that already lists the project. |
| `--ci-evidence github\|gitlab` | none | Also write `.testguard/fetch-ci-evidence.sh`, an on-demand helper that downloads CI's evidence artifact and briefs from it. See [artifacts](artifacts.md#fetch-ci-evidencesh). Any other value is a usage error (exit `3`) and nothing is written. |
| `--mcp` | off | Print the MCP server configuration for Claude Code, Cursor and Codex. Printed, never written. See [MCP](mcp.md#register-the-server). |
| `--json` | off | Print `{done, skipped, warnings, agentRoot, dir, mcpConfig?}`. |

**Exit:** `0`; `1` when a file it wrote is ignored by git (it is reported, not
offered for commit); `2` when `.claude/settings.json` is not valid JSON or not
an object init can add a hook to (the message names the file); `3` for a bad
option. On `2` or `3` nothing is written: every check runs before the first
write.

**`--json` schema:** none published.

## claims

```bash
npx testguard-cli claims [dir] [--claims <path>] [--check-anchors] [--since <ref>] [--cost] [--json]
npx testguard-cli claims [dir] --annotate [--claim <ID,ID>] [--apply] [--json]
```

Validates the claims file and lists every claim with its severity, source,
fault count and defenders, including the discovery split
(`1 import · 0 mock · 1 can detect`). It reports drift against `@claim <ID>`
annotations in source (test files are not scanned) and static defender
signals such as `MOCKED-NEVER-ASSERTED`. It never runs a test.

| Flag | Default | Meaning |
|---|---|---|
| `--claims <path>` | `<dir>/testguard.claims.json` | The claims file to read. |
| `--check-anchors` | off | Locate every exact anchor and syntax-check each JavaScript and Python replacement in memory. No tests, no worktree, no file changes. |
| `--python <path>` | resolved as for [probe](#probe) | The interpreter `--check-anchors` uses to parse Python replacements. |
| `--since <ref>` | none | Report every claim and fault that existed at `<ref>` and does not now (`removed-claim`, `removed-fault`; a rename with the same statement is `renamed-claim` and does not fail). |
| `--ignore <path>` | `<dir>/testguard.ignore.json` | With `--since`: the ignore file whose `claim` and `fault` entries excuse a removal. |
| `--cost` | off | What the last probe spent, per claim, per fault and per defender file, read back from recorded run durations. Re-measures nothing. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | With `--cost`: the evidence to read the durations from. |
| `--annotate` | off | Read-only preview of `@claim` file-header placement (JavaScript, TypeScript, Python). |
| `--claim <ID,ID>` | every claim | With `--annotate`: the claims to place. Repeatable and comma-separated. |
| `--apply` | off | With `--annotate` only: write the annotations, keeping private recovery copies. Each run recomputes its plan; an earlier preview is not an approval token. |
| `--json` | off | Print the inspection document (or the annotation document with `--annotate`). |

**Exit:** `0`; `1` when an annotation has no claim (`UNDECLARED`), an
annotation-sourced claim has no annotation (`STALE`), a claim or fault was
removed without an excusing entry (`--since`), or an anchor is missing,
ambiguous or its replacement does not compile (`--check-anchors`); `2` when the
claims file is unreadable or invalid. With `--annotate`: `0` for an applicable
preview or a verified apply, `2` for a refusal or partial failure, `3` for
options that cannot combine with authoring (`--apply` without `--annotate`, or
`--annotate` with anything but `--claims`, `--claim`, `--apply`, `--json`).

**`--json` schema:** none published for the inspection document
(`{path, claims, annotations, drift, annotationAdvisory, narrowedDefenders?, anchorChecks?, removed?, cost?}`);
[`annotations.schema.json`](../../spec/schemas/annotations.schema.json) with
`--annotate`.

## probe

```bash
npx testguard-cli probe [dir] [options]
```

For each fault: confirms the defenders are green N times on unmodified code,
applies the fault in a scratch git worktree (your tree is never touched), runs
the defenders N times, re-runs survivors against the whole suite to name
undeclared killers, restores, and classifies the result into one of seven
[verdicts](verdicts.md#probe-verdicts). Findings are ranked by severity, claim
provenance and blast radius, and written as evidence validated against the
spec before it is written.

| Flag | Default | Meaning |
|---|---|---|
| `--claims <path>` | `<dir>/testguard.claims.json` | Claims file. |
| `--confirm <n>` | `3` | Runs per verdict. Below 3 the run is **provisional**: verdicts print with `?` and the evidence goes to `evidence-provisional.json`. |
| `--budget <ms>` | `120000` | Wall clock for each runner invocation. At least `1000`. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole probe. Caps asynchronous children; expiry exits `2` and writes no partial result. At least `1000`. |
| `--out <path>` | see below | Evidence file. |
| `--baseline <path>` | `<dir>/.testguard/baseline.json` if present | Baseline to gate against. |
| `--severity <level>` | `low` | Gate only findings whose claim severity is at or above this level. Findings below are still reported and written. |
| `--claim <ID,ID>` | every claim | Probe only these claims. Repeatable, order-preserving, duplicates collapsed. Writes `evidence-partial.json`. |
| `--include-dirty` | off | Probe the working tree (snapshotted into a throwaway commit) instead of HEAD, so uncommitted tests count. |
| `--ref <commit>` | `HEAD` | Probe this commit in the scratch worktree. Honoured even when defender or target files are dirty: a warning names them and the evidence records them as `repo.ignoredDirty`. |
| `--ignore-dirty` | off | Probe HEAD as committed although defender or target files are dirty (same warning and record). Without this, `--include-dirty` or an explicit `--ref`, a dirty defender or target is refused. |
| `--in-place` | off | Mutate the working tree instead of a scratch worktree. Only fault target files must be clean. |
| `--runner <name>` | `auto` | Test runner. See the table below. |
| `--runner-cmd "<cmd>"` | none | A custom runner command; must contain `{files}` and `{out}`, e.g. `"pnpm vitest run {files} --reporter=json --outputFile={out}"`. |
| `--node-modules <dir>` | `TESTGUARD_NODE_MODULES` | `node_modules` to link into the scratch worktree when it cannot see yours. |
| `--python <path>` | `TESTGUARD_PYTHON`, then `$VIRTUAL_ENV`, then `.venv`, `venv`, `.env` in the project, then `python3`, `python` on `PATH` | Interpreter for `.py` defenders, resolved against your working tree. |
| `--workers <n>` | `1` | Maximum built-in runner workers. Python stays serial. |
| `--serial` | off | One test file at a time (vitest `--no-file-parallelism`, jest `--runInBand`, playwright `--workers=1`, pytest `-p no:xdist`). |
| `--no-escalate` | off | Do not re-run survivors against the whole suite. Escalation runs the whole suite up to N times per survivor. |
| `--no-reuse` | off | Re-probe claims whose recorded inputs have not changed. |
| `--allow-empty` | off | Adoption only: a valid claims file with zero claims exits `0` instead of `2`, writes no evidence, and says verification was skipped. Has no effect with `--claim`. |
| `--require-origin <kinds>` | none | Require every claim's declared source kind to be in this set (repeatable, comma-separated). Needs a complete confirmed run: refused with `--claim`, `--allow-empty`, `--ref`, `--ignore-dirty` or `--confirm` below 3. Labels do not authenticate independence. |
| `--progress <mode>` | `auto` | `auto`, `tty`, `plain`, `ndjson` or `none`. Always on stderr. `--quiet` and `--json` imply `none` unless this is given explicitly. |
| `--verbose` | off | Also print every killed fault. |
| `--quiet` | off | Print only the summary and the evidence path. |
| `--cost` | off | Also report what this run's defenders cost. |
| `--changed <ref>` | detected | With `--json`: include claim coverage of the change in the status document. |
| `--json` | off | Print the status document plus this run's result. |

Where the evidence goes, unless `--out` says otherwise:

| Run | File |
|---|---|
| Complete, `--confirm` 3 or more | `.testguard/evidence.json` |
| `--claim` selection | `.testguard/evidence-partial.json` |
| `--confirm` below 3 | `.testguard/evidence-provisional.json` |

Partial and provisional runs never overwrite the canonical evidence: only a
confirmed, complete run may feed a baseline.

| `--runner` | What runs |
|---|---|
| `auto` | The first of `vitest`, `jest`, `python` that resolves. A defender under Playwright's `testDir` always runs under `playwright`, and a `.py` defender always under `python`, whatever the project runner. |
| `vitest` | Vitest, resolved from the project's own package first. |
| `jest` | Jest, resolved the same way. |
| `playwright` | Playwright Test. |
| `python` | pytest when the interpreter can import it, stdlib `unittest` otherwise. |
| `pytest` | pytest, and fail rather than fall back. |
| `unittest` | stdlib `unittest`, and fail rather than fall back. |
| `node-test` | Node's built-in test runner, using the Node executable running TestGuard. Explicit only; `auto` never picks it. |

Detection, limits and per-runner behaviour are in
[languages and runners](languages-and-runners.md).

**Exit:** `0` no new gating finding at or above the severity floor; `1` at
least one new finding, or a failed `--require-origin` policy (which baseline
debt and severity floors cannot hide); `2` precondition (an empty claims file
without `--allow-empty`, a runner that does not resolve, a dirty defender or
target with the implicit HEAD, an exhausted command budget, an unavailable
origin policy); `3` usage (`--confirm` not a positive integer, `--budget` or
`--command-budget` below 1000, `--workers` not a positive integer, an unknown
`--progress` mode, an empty `--claim`).

**`--json` schema:** [`status.schema.json`](../../spec/schemas/status.schema.json),
with `run` = `{id, evidence, provisional, records, newSinceBaseline, exitCode, originPolicy?, scope?}`
and `cost` when `--cost` is given. The evidence file itself conforms to
[`evidence.schema.json`](../../spec/schemas/evidence.schema.json).

## baseline

```bash
npx testguard-cli baseline [dir] [--evidence <path>] [--out <path>] [--allow-provisional] [--restamp] [--json]
```

Freezes the fingerprint of every non-passing finding in the evidence. Later
probes suppress what was already known and exit non-zero only on what is new.
It prints the `.gitignore` lines for any regenerated output git does not yet
ignore. Commit the baseline it writes.

| Flag | Default | Meaning |
|---|---|---|
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Evidence to freeze. |
| `--out <path>` | `<dir>/.testguard/baseline.json` | Baseline to write. |
| `--allow-provisional` | off | Freeze evidence from a run with `--confirm` below 3. Normally refused. |
| `--restamp` | off | Move an existing baseline's `head` to the commit of a later, clean probe that reproduced exactly the same fingerprints. A baseline frozen from `--include-dirty` evidence points at the parent of the commit that carries its tests; this moves it once you have committed. |
| `--json` | off | Print the status document plus `baseline: {path, frozen}` (or `{path, restamped}`). |

**Exit:** `0`; `2` when there is no evidence, the evidence is provisional
without `--allow-provisional`, or `--restamp` cannot apply (no baseline yet,
evidence from a dirty tree or snapshot, or different fingerprints).

**`--json` schema:** the status document from
[`status.schema.json`](../../spec/schemas/status.schema.json) plus a
`baseline` key; the baseline file conforms to
[`baseline.schema.json`](../../spec/schemas/baseline.schema.json).

## brief

```bash
npx testguard-cli brief [dir] [--text | --markdown] [--max <n>] [--evidence <path>] [--baseline <path>] [--json]
```

Turns evidence plus baseline into a ranked, capped `## TEST BLINDSPOT CONTEXT`
block, with the next action and unclaimed changed files first. Without
`--text` or `--markdown` it also writes `.testguard/brief.json`. The first line
says which install answered (`local install`, `npx cache`, `pnpm dlx cache`,
`bunx cache` or `global`), so a stale one is visible.

| Flag | Default | Meaning |
|---|---|---|
| `--text` | off | Print only; write nothing. With no evidence it prints the unclaimed changes, if any, and exits `0` silently otherwise. This is the form the session-start hook uses. |
| `--markdown` | off | Print only, rendered as a merge-request note for a human reviewer, unclaimed changes first. Same silence rule as `--text`. |
| `--max <n>` | `20` | Items in the brief, 1 to 50. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Evidence to brief from. |
| `--baseline <path>` | `<dir>/.testguard/baseline.json` if present | Baseline that marks findings as known. |
| `--changed <ref>` | detected | Reference for the unclaimed-changes section. A detected reference that does not resolve is silent here. |
| `--include-dirty` | off | With a reference, measure the working tree. |
| `--out <path>` | `<dir>/.testguard/brief.json` | Where the brief document is written (ignored with `--text`/`--markdown`). |
| `--json` | off | Print the brief document. |

**Exit:** `0`; `2` when there is no evidence and neither `--text` nor
`--markdown` was given; `3` when `--max` is outside 1–50.

**`--json` schema:** [`brief.schema.json`](../../spec/schemas/brief.schema.json).

## gate

```bash
npx testguard-cli gate [dir] [--changed <ref>] [--include-dirty] [--exclude <glob>]... [--strict] [--ignore <path>] [--json]
npx testguard-cli gate --explain
```

Measures claim coverage of a change. Every changed source file must carry a
fault, resolve as a defender of a claim (test files), or be excused by an
unexpired `path` entry in the ignore file. One unclaimed file fails; there is
no percentage. Every reliance on an ignore entry is printed, and an expired
entry excuses nothing. It always writes `.testguard/gate.json`.

| Flag | Default | Meaning |
|---|---|---|
| `--changed <ref>` | detected | Measure the change since `merge-base(ref, HEAD)`. |
| `--include-dirty` | off | Compare the working tree (staged, unstaged, untracked) instead of HEAD. The pre-commit shape is `gate --changed HEAD --include-dirty`. |
| `--exclude <glob>` | none | More files that never carry claims. Repeatable. |
| `--explain` | off | Print the default exclusions and exit `0`. |
| `--strict` | off | A non-empty change that evaluates nothing is a failure, not a note. |
| `--ignore <path>` | `<dir>/testguard.ignore.json` | Ignore file. |
| `--claims <path>` | `<dir>/testguard.claims.json` | Claims file. |
| `--out <path>` | `<dir>/.testguard/gate.json` | Gate document. |
| `--quiet` | off | Omit the `gate: <path>` line and the "comparing against" note. |
| `--json` | off | Print the gate document. |

When `--changed` is absent the reference is detected, first match wins:
`TESTGUARD_CHANGED_REF`; `GITHUB_BASE_REF` (as `origin/<branch>`);
`CI_MERGE_REQUEST_DIFF_BASE_SHA`; `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (as
`origin/<branch>`); then, in an ordinary clone on a branch, the remote's
symbolic default branch, or a configured upstream whose branch name differs
from the current one. A same-name tracking branch is never picked, because it
would produce a misleading empty diff. The gate says which reference it chose.

Source files are `.js .mjs .cjs .ts .mts .cts .jsx .tsx .py`; everything else
is excluded as non-source. The default exclusions (`--explain`) are
`**/*.d.ts`, `**/*.config.*`, `**/*.stories.*`, `**/*.generated.*`,
`**/fixtures/**`, `**/__fixtures__/**`, `**/__mocks__/**`,
`**/__snapshots__/**` and `.testguard/**`. A directory with its own valid
`testguard.claims.json` is a nested project: its files are reported as
delegated, not counted as coverage here (see the
[monorepo guide](../guides/monorepo.md)).

**Exit:** `0` every changed source file is claimed or excused; `1` an
unclaimed file, or `--strict` with nothing evaluated; `2` cannot evaluate (the
reference does not resolve, invalid claims); `3` no reference could be found.

**`--json` schema:** [`gate.schema.json`](../../spec/schemas/gate.schema.json).

## scaffold

```bash
npx testguard-cli scaffold <source-file> [--claim <ID>] [--claims <path>] [--out <path>] [--json]
npx testguard-cli scaffold <source...> --into <draft.json> --claim <ID> [--json]
npx testguard-cli scaffold --from-document <local-text-path> [--json]
npx testguard-cli scaffold --from-fix <full-commit-ID> [--json]
```

Proposes faults mechanically: exact anchors, `expectHits` computed from the
file, `defendedBy` prefilled from the tests that import the module, `TODO`
statements. The output is a draft, never your claims file; a proposal becomes
a claim only when a person states what it defends. Run it from the project
directory: the project is the current directory, and the source path must be
inside it. The fault shapes it proposes are listed in
[writing claims](../guides/writing-claims.md).

| Mode | Flags | What it does |
|---|---|---|
| One file | `--claim <ID>` (put every proposal under this claim; copies it from the claims file if it exists), `--claims <path>`, `--out <path>` | Writes `.testguard/scaffold-<basename>.json`. With `--json`, prints the draft and writes nothing. |
| Append | `--into <existing-draft.json>` and exactly one `--claim <ID>` that exists in the draft; one or more sources | Appends proposals to a draft you have already given intent to. `--json` previews without writing. No other options are accepted, and canonical claims, evidence and baseline paths are refused. |
| Input inspection | exactly one of `--from-document <path>` or `--from-fix <sha>`; only `--json` alongside | Read-only, stdout only, metadata only: document text is never printed. `--from-fix` needs a full lowercase SHA-1 or SHA-256 commit ID with exactly one parent. Verification is not performed. |

**Exit:** `0`; `2` the file does not exist or is outside the project, or an
append or input inspection was refused; `3` usage (no source, more than one
source without `--into`, a repeated or comma-separated `--claim`, a
conflicting option).

**`--json` schema:** [`claims.schema.json`](../../spec/schemas/claims.schema.json)
for a draft and for `--into`;
[`authoring-input.schema.json`](../../spec/schemas/authoring-input.schema.json)
for `--from-document` and `--from-fix`.

## sweep

```bash
npx testguard-cli sweep [dir] --changed <ref> [--cap <n>] [options]
npx testguard-cli sweep [dir] --save-paths [--cap <n>] [options]
npx testguard-cli sweep [dir] --concern <ID> [--cap <n>] [options]
```

The cold start: no claim needed. Takes the changed source files that carry no
claim, proposes faults with the same producers as `scaffold`, probes a bounded
selection ordered by how productive each fault class has been in this
repository, and reports what a green suite did not notice. It never writes
`testguard.claims.json`, and its evidence never replaces
`.testguard/evidence.json`.

| Flag | Default | Meaning |
|---|---|---|
| `--changed <ref>` | detected (as for [gate](#gate)) | The change to sweep. Required unless `--save-paths` or `--concern` is given. |
| `--save-paths` | off | Sweep every file that writes to storage instead of the diff, and report that surface as the denominator. Sugar for the built-in `SAVE-PERSISTS` concern. |
| `--concern <ID>` | none | Aim the sweep by one concern: its targets and its fault classes. `concerns` lists them. |
| `--concerns <path>` | `<dir>/testguard.concerns.json` | A custom concerns file. |
| `--cap <n>` | 7 per target file (at least 7) | Faults to probe. The rest are reported as deferred, not as a verdict. |
| `--include-dirty` | off | Measure the working tree instead of HEAD. |
| `--exclude <glob>` | none | More files to leave out. Repeatable. |
| `--confirm <n>` | `3` | Runs per verdict. |
| `--budget <ms>` | `120000` | Wall clock per runner invocation. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole sweep; expiry exits `2` and writes nothing. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One test file at a time. |
| `--runner`, `--runner-cmd`, `--node-modules` | as for [probe](#probe) | Runner selection. |
| `--claims <path>`, `--ignore <path>` | project defaults | Files used to decide which changed files are unclaimed. |
| `--max <n>` | `20` | Findings printed in the text report. |
| `--out <path>` | `<dir>/.testguard/sweep.json` | Sweep document. |
| `--quiet` | off | Omit warnings and the `sweep: <path>` line. |
| `--json` | off | Print the sweep document. |

**Exit:** `0` nothing survived; `1` a fault survived or a swept file has no
test that imports it (`survived` or `nocover`; see
[sweep exit semantics](verdicts.md#sweep)); `2` cannot evaluate; `3` no
reference, `--cap` not a positive integer, or an unknown `--concern`.

**`--json` schema:** [`sweep.schema.json`](../../spec/schemas/sweep.schema.json).

## concerns

```bash
npx testguard-cli concerns [dir] [--concerns <path>] [--json]
```

Lists the concerns a sweep can be aimed by: the project's own from
`testguard.concerns.json`, then the two built-ins (`SAVE-PERSISTS`,
`CHANGED-CODE`) that the project has not replaced. It validates the file and
reports a replaced built-in. A concern is a scope, never a claim. The file
format is in [configuration](configuration.md#concerns-file).

| Flag | Default | Meaning |
|---|---|---|
| `--concerns <path>` | `<dir>/testguard.concerns.json` | Read this concerns file instead. |
| `--json` | off | Print `{schemaVersion, tool, source, shadowed, concerns}`. |

**Exit:** `0`; `2` when the file does not conform to the schema. It has no
exit code that means something is wrong with the project.

**`--json` schema:** none published for the listing; the file itself conforms
to [`concerns.schema.json`](../../spec/schemas/concerns.schema.json).

## mcp

```bash
npx testguard-cli mcp
```

Serves five read-only tools over the Model Context Protocol (JSON-RPC 2.0,
newline-delimited, on stdio), so the operating loop works in any agent
harness. No tool runs a probe or writes a file. Tools, inputs and setup are in
the [MCP reference](mcp.md).

It takes no options. `--json` is refused with exit `3`; otherwise it runs
until stdin closes and exits `0`.

## replay

```bash
npx testguard-cli replay [dir] --since <range> [--max <n>] [options]
```

For each fix commit in the range (one that changes source and a test
together) it checks the commit out in a scratch worktree, reverts only the
source files to the parent, deletes the test the fix shipped, and runs the
tests that import the reverted code. One patch counts once (`git patch-id`).
It writes a replay document and, beside it, a calibration document: per fault
class, how often a real escaped bug of that class was missed. It reports and
never gates. See the [replay guide](../guides/replay.md).

| Flag | Default | Meaning |
|---|---|---|
| `--since <range>` | required | Commit range to search: `HEAD~50..HEAD`, a tag, `origin/main..HEAD`. `--changed <range>` is accepted as an alias. |
| `--max <n>` | `20` | Replay at most this many fix commits. Each costs a worktree and N runs. |
| `--confirm <n>` | `3` | Runs per verdict. Mixed runs are never `caught`. |
| `--budget <ms>` | `120000` | Wall clock per run. |
| `--command-budget <ms>` | none | Cooperative deadline; expiry writes neither the replay nor the calibration. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One test file at a time. |
| `--runner`, `--runner-cmd`, `--node-modules` | as for [probe](#probe) | Runner selection. |
| `--out <path>` | `<dir>/.testguard/replay.json` | Replay document. The calibration is written as `calibration.json` in the same directory. |
| `--baseline <path>` | beside the replay document | Write the calibration document to this path instead. |
| `--json` | off | Print `{replay, calibration, paths}`. |

**Exit:** `0` whatever the verdicts; `2` when the range holds no fix commits
or another precondition fails; `3` when `--since` is missing or a number is
malformed.

**`--json` schema:** the two documents conform to
[`replay.schema.json`](../../spec/schemas/replay.schema.json) and
[`calibration.schema.json`](../../spec/schemas/calibration.schema.json).

## admit

```bash
npx testguard-cli admit <test-file> --claim <ID> [--fault <FID>] [--confirm <n>] [--json]
```

The two-gate rule as one verb: is this test green on unmodified HEAD, and does
it fail on every fault of the claim, N/N? It is sugar over
`probe --claim <ID> --include-dirty --no-escalate`, so it can never disagree
with the gate. The test may be uncommitted. The project is the nearest
directory above the test file that holds `testguard.claims.json` (or the
directory of `--claims`).

| Flag | Default | Meaning |
|---|---|---|
| `--claim <ID>` | required | Exactly one claim. |
| `--fault <FID>` | every fault of the claim | Admit against one fault only. |
| `--confirm <n>` | `3` | Runs per verdict. Below 3 the answer is `ADMITTED?`, provisional. |
| `--budget <ms>` | `120000` | Wall clock per runner invocation. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole admission. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One test file at a time. |
| `--claims <path>` | found from the test file | Claims file; its directory is the project. |
| `--out <path>` | `<project>/.testguard/evidence-partial.json` | Evidence file. Never the canonical one. |
| `--runner`, `--runner-cmd`, `--node-modules` | as for [probe](#probe) | Runner selection. |
| `--quiet` | off | Suppress progress and the provisional warning. |
| `--json` | off | Print `{admitted, provisional, claim, test, faults, evidence, command}`. |

**Exit:** `0` ADMITTED; `1` NOT ADMITTED, naming the first blocking fault and
what to do about it; `2` the file does not exist, the claim or fault is
unknown, or another precondition failed; `3` usage, or the test is not a
declared or discovered defender of the claim (the message says how to declare
it). Verdict meanings are in [verdicts](verdicts.md#admit).

**`--json` schema:** none published for the result; the evidence file conforms
to [`evidence.schema.json`](../../spec/schemas/evidence.schema.json).

## Next

- [Verdicts and signals](verdicts.md): what each verdict and signal in the output means.
- [Configuration](configuration.md): the claims, ignore and concerns files and the environment variables.
- [Artifacts](artifacts.md): every file under `.testguard/`, and which to commit.
- [How it works](../concepts/how-it-works.md): the loop these commands form.
