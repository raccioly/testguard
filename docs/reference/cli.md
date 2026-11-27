# CLI reference

This page lists every TestGuard command, every flag it reads, what it writes
and how it exits. Use it to look things up. The guides explain when to use each
command. The flags come from the CLI's own parser (`src/cli.mjs`) and the
command modules (`src/commands/*.mjs`). That includes the flags the top-level
`--help` does not print.

```bash
npx testguard-cli --help              # the overview
npx testguard-cli probe --help        # one command's options
npx testguard-cli --version           # the installed version
```

## Global flags

| Flag | Meaning |
|---|---|
| `--json` | Print a machine-readable document instead of text. Every command except `mcp` accepts it. `mcp` refuses it (exit `3`), because anything printed on stdout would corrupt the protocol stream. |
| `--help`, `-h` | Print help. With a command, that command's options; without one, the overview. |
| `--version`, `-v` | Print the version and exit `0`. |

TestGuard validates two flags for every command, whether or not that command
uses them. `--runner` must be one of the runner names below or `auto`.
`--severity` must be `critical`, `high`, `medium` or `low`. An unknown flag, an
unknown command, or no command at all exits `3`.

Commands that take `[dir]` treat it as the project directory, the one that
holds `testguard.claims.json`. It defaults to the current directory. `scaffold`
and `admit` take a file instead and find the project a different way (see
their sections).

## Exit codes

The exit code is the contract. Integrations read it. They never parse text.

| Code | Meaning |
|---|---|
| `0` | Nothing new to prove. |
| `1` | A finding: unproven claims, claim drift, unclaimed changes or invalid fault anchors. |
| `2` | A precondition failed and nothing was measured: an invalid claims file, a runner that does not resolve, a reference that does not resolve, missing evidence, an exhausted `--command-budget`. |
| `3` | Usage: the request is wrong whatever the repository holds. Examples: a missing or malformed option, an unknown command or flag, or flags that cannot be combined (for example `--in-place` with `--ref`, `--include-dirty` or `--fault-workers` above 1). |

**Under `--json`, a refusal is one `error` document on stdout** (`{schemaVersion, tool, error: {kind, message, exitCode}}`,
[`error.schema.json`](../../spec/schemas/error.schema.json)). This holds for every exit `2` and exit `3`. The human message stays on stderr.
Stdout is never empty on a refusal. `exitCode` is `3` exactly when `kind` is `usage`. Branch on `kind`: `usage`, `claims-file`, `git`, `spec-document`, `refused`, `internal`, or one of the precondition kinds (`no-commits`, `ref-unresolved`, `dirty-tree`, `runner-unresolvable`, `discovery-failed`, `typecheck-unavailable`, `typecheck-red-baseline`, `typecheck-timeout`, `budget-exhausted`, and the defender and scratch-directory kinds; the closed list is in the schema). An undetermined `probe --changed` keeps writing the status document it always did (`run.exitCode: 2`, `run.scope.changed.outcome: "undetermined"`). So read `error` first. When it is present, nothing was measured.

**Interruption.** A probe, sweep, replay or admit can receive a signal. It then stops its test runners, removes its scratch worktrees and exits with the shell's code for that signal: `130` for SIGINT, `143` for SIGTERM, `129` for SIGHUP. It prints one line to stderr, `interrupted by <signal>; scratch trees removed` (or, when a cleanup step failed, `scratch cleanup did not finish (see above)`). It publishes no partial result.

A command can crash on a defect in TestGuard itself. It then prints
`error: this is a bug in testguard <version>, not a problem with your project.`
with a stack trace, and exits `2`. Each command's own section below says which
of these codes it can return. The official rules are in
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
| [`clean`](#clean) | Remove the scratch trees and locks interrupted runs left behind. |

## status

```bash
npx testguard-cli status [dir] [--json] [--changed <ref>] [--include-dirty] [--evidence <path>]
```

This command computes the project's state from the claims file, the evidence,
the baseline and the working tree. It names the one next action. It is the
single source of truth: the CLI text, the brief, the skill and the MCP tools
all derive from the same document, so they cannot disagree. It writes nothing.

| Flag | Default | Meaning |
|---|---|---|
| `--json` | off | Print the status document. |
| `--changed <ref>` | detected (see [gate](#gate)) | Also compute claim coverage of the change since `merge-base(ref, HEAD)`. `unclaimed-changes` then precedes every evidence state. An explicit reference that does not resolve is an error. A detected one that does not resolve prints a warning, and status continues without it. |
| `--include-dirty` | off | With a reference, compare the working tree (staged, unstaged and untracked) instead of HEAD. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Read this evidence instead, for example CI's, fetched as an artifact. TestGuard still computes staleness from the recorded input hashes, and it names both commits. |

| State | Exit |
|---|---|
| `clean` | `0` |
| `no-claims`, `unprobed` | `2` |
| `unclaimed-changes`, `invalid-anchors`, `evidence-stale`, `provisional-only`, `unproven` | `1` |

`next.action` is one of `scaffold`, `claim`, `probe`, `write-test`,
`baseline`, `review-fault-change`, `repair-fault`, `none`, and `next.command`
is the exact shell line to run.

`advice` lists where the project loses speed. Each item is one line with the
command to run: `serial-on-multicore`, `full-probe-where-changed-would-do`, `slow-defenders-dominate`,
`nothing-reused`, `hook-outdated`, `orphaned-scratch` (leftovers of interrupted runs: `testguard clean`). It is informational. It never changes
`state`, `next` or the exit code, and it reads only files on disk. The text form
prints each item as a `speed` line.

**`--json` schema:** [`status.schema.json`](../../spec/schemas/status.schema.json).

## init

```bash
npx testguard-cli init [dir] [--here] [--force] [--upgrade] [--pin] [--activate-hook] [--ci github|gitlab] [--ci-evidence github|gitlab] [--mcp] [--json]
```

`init` installs two layers. The **agent layer** goes to the git root, where
agent sessions run: `.claude/skills/testguard/SKILL.md`, a SessionStart hook in
`.claude/settings.json` that runs `brief --text`, and a TestGuard section in
`AGENTS.md`. The **project layer** (the `.gitignore` lines for regenerated
outputs) goes in `[dir]`. It is idempotent. A second project in the same
repository adds a hook line and an `AGENTS.md` bullet, never a duplicate. The
hook prefers a local install, then a `testguard` on `PATH`, then does nothing.
It never reaches the network.

It also writes a **pre-push block** that runs `probe --changed auto`. The block
goes in `.husky/pre-push` when the repository has `.husky/`, otherwise in
`.githooks/pre-push`. Anything else in that file stays.

Sometimes a hook file already mentions TestGuard outside a managed block. That
file is the project's own (runner flags, a probe somebody paused). `init` and
`init --upgrade` write no block there. They report it and print the block they
would have written (`--force` adds it).

`init` then checks that the file is on this clone's **active hooks path**
(`core.hooksPath`, husky, or a hook in the active directory that calls it). It
reports the file when git would never run it. Two cases apply:

- `.git/hooks` already holds other hooks. `init` prints a small
  `.git/hooks/pre-push` that calls the tracked file. Repointing `core.hooksPath`
  would silently disable the other hooks.
- `.git/hooks` holds no hooks. `init` prints `git config core.hooksPath .githooks`.

`init` never changes git config and never writes `.git/` by itself.
`--activate-hook` does the recommended one. Then `init` reports, with `~` lines,
every hook and CI line that has one of these: `probe --serial`, a full probe on
every push, a pinned older `testguard-cli`, a floating version (the `latest`
tag, or `npx
testguard-cli` with no version) or an older TestGuard template.

The pre-push block runs an installed TestGuard only (the project's, the
repository root's, then one on `PATH`). With none, it prints how to install the
exact version that ran `init` and lets the push through. It fetches nothing. The
CI files run the project's installed TestGuard first, else exactly that version
through `npx`. Nothing runs a floating tag.

With a `package.json`, `init` **recommends**, under "Recommended", pinning
`testguard-cli` at that exact version in `devDependencies`. It also recommends a
Dependabot rule (or a Renovate rule when the repository has a Renovate config).
Then a new release arrives as a pull request that your CI gates. `init` writes
none of it unless you pass `--pin`. The pin leaves the lockfile out of date,
and some projects forbid those files in their own rules.

| Flag | Default | Meaning |
|---|---|---|
| `--here` | off | Keep the agent layer in `[dir]` instead of the git root, for a subdirectory that is its own agent root. |
| `--force` | off | Replace an existing skill file (and an existing `.testguard/fetch-ci-evidence.sh`), and TestGuard blocks edited by hand. It does not refresh an `AGENTS.md` section that already lists the project. |
| `--upgrade` | off | Rewrite what TestGuard wrote and nobody edited to the current template. That covers the skill, the `AGENTS.md` section, the pre-push block and the `--ci` file. Each managed block carries `template=<n>` and the hash of its body. TestGuard reports an edited block and leaves it alone. It rewrites an `AGENTS.md` section only when the section is byte-for-byte a template TestGuard shipped. It leaves and reports any other. `--upgrade` never adds a pre-push block to a hook that had none from TestGuard. It never writes `package.json` or an update rule. See [upgrading](../upgrade.md#024-fast-by-default). |
| `--pin` | off | Also write the exact `devDependencies` pin and the Dependabot or Renovate rule, as 0.25.0 did (run your install afterwards so the lockfile records the pin). Ignored with `--upgrade`. |
| `--activate-hook` | off | Make this clone run the pre-push hook `init` wrote: set `core.hooksPath`, or write a `.git/hooks/pre-push` that calls it and keeps the other hooks. TestGuard never edits a `pre-push` already in `.git/hooks`, another hooks directory or husky. |
| `--ci github\|gitlab` | none | Write `.github/workflows/testguard.yml` (GitHub) or `testguard.gitlab-ci.yml` to `include:` (GitLab). Pull or merge requests run `probe --changed auto`. Scheduled and manual runs run `probe`. `.testguard/evidence.json` is cached. The file runs the project's installed TestGuard, else `npx -y testguard-cli@<the version that ran init>`, and pins every action by commit SHA. Any other value is a usage error (exit `3`). |
| `--ci-evidence github\|gitlab` | none | Also write `.testguard/fetch-ci-evidence.sh`, an on-demand helper that downloads CI's evidence artifact and briefs from it. See [artifacts](artifacts.md#fetch-ci-evidencesh). Any other value is a usage error (exit `3`), and nothing is written. |
| `--mcp` | off | Print the MCP server configuration for Claude Code, Cursor and Codex. It prints the configuration and never writes it. See [MCP](mcp.md#register-the-server). |
| `--json` | off | Print `{done, skipped, warnings, agentRoot, dir, mcpConfig?}`. |

When the project has no JavaScript, TypeScript or Python source, and it has
files in a language TestGuard knows but cannot probe (for example Apex or Java),
`init` prints a note that names the language and the file count. It changes
neither the exit code nor the files written.

**Exit:** `0`; `1` when git ignores a file `init` wrote (`init` reports it and
does not offer it for commit); `2` when `.claude/settings.json` is not valid
JSON or not an object `init` can add a hook to (the message names the file);
`3` for a bad option. On `2` or `3` nothing is written, because every check
runs before the first write.

**`--json` schema:** none published.

## claims

```bash
npx testguard-cli claims [dir] [--claims <path>] [--check-anchors] [--since <ref>] [--cost] [--json]
npx testguard-cli claims [dir] --annotate [--claim <ID,ID>] [--apply] [--json]
```

This command validates the claims file and lists every claim with its
severity, source, fault count and defenders. That includes the discovery split
(`1 import · 0 mock · 1 can detect`). It reports drift against `@claim <ID>`
annotations in source (it does not scan test files). It also reports static
defender signals such as `MOCKED-NEVER-ASSERTED`. It never runs a test.

| Flag | Default | Meaning |
|---|---|---|
| `--claims <path>` | `<dir>/testguard.claims.json` | The claims file to read. It may live outside the project: see [external claims files](../../spec/GATE-SEMANTICS.md#external-claims-files). |
| `--check-anchors` | off | Locate every exact anchor and syntax-check each JavaScript and Python replacement in memory. No tests, no worktree, no file changes. |
| `--python <path>` | resolved as for [probe](#probe) | The interpreter `--check-anchors` uses to parse Python replacements. |
| `--typecheck[=<cmd>]` | off | With `--check-anchors`: also type check each replacement that still parses, as [probe](#probe) does. It runs in a scratch worktree of the working tree, so the project is never touched. A replacement the checker refuses is `FAULT-INVALID` with the first diagnostic. A file the checker does not judge says `type check not applicable`. A working tree that already fails the check is exit `2`. Without `--check-anchors`, the flag is refused (exit `3`). |
| `--since <ref>` | none | Report every claim and fault that existed at `<ref>` and does not now (`removed-claim`, `removed-fault`). A rename with the same statement is `renamed-claim` and does not fail. |
| `--ignore <path>` | `<dir>/testguard.ignore.json` | With `--since`: the ignore file whose `claim` and `fault` entries excuse a removal. |
| `--cost` | off | What the last probe spent, per claim, per fault and per defender file, read back from recorded run durations. Re-measures nothing. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | With `--cost`: the evidence to read the durations from. |
| `--annotate` | off | Read-only preview of `@claim` file-header placement (JavaScript, TypeScript, Python). |
| `--claim <ID,ID>` | every claim | With `--annotate`: the claims to place. Repeatable and comma-separated. |
| `--apply` | off | With `--annotate` only: write the annotations, and keep private recovery copies. Each run recomputes its plan. An earlier preview is not an approval token. |
| `--json` | off | Print the inspection document (or the annotation document with `--annotate`). |

**Exit:** `0`. `1` when an annotation has no claim (`UNDECLARED`), when an
annotation-sourced claim has no annotation (`STALE`), when a claim or fault was
removed without an excusing entry (`--since`), or when an anchor is missing,
ambiguous or its replacement does not compile (`--check-anchors`). `2` when the
claims file is unreadable or invalid. With `--annotate`: `0` for an applicable
preview or a verified apply, `2` for a refusal or partial failure, and `3` for
options that cannot combine with authoring (`--apply` without `--annotate`, or
`--annotate` with anything but `--claims`, `--claim`, `--apply`, `--json`).

**`--json` schema:** none published for the inspection document
(`{path | claimsSource, claims, thinClaims, annotations, drift, annotationAdvisory, narrowedDefenders?, anchorChecks?, removed?, cost?}`; `claimsSource` replaces `path` for an external claims file; `thinClaims` is the advisory `claim-thin` list);
[`annotations.schema.json`](../../spec/schemas/annotations.schema.json) with
`--annotate`.

## probe

```bash
npx testguard-cli probe [dir] [options]
```

For each fault, `probe` does these steps:

1. It confirms the defenders are green N times on unmodified code.
2. It applies the fault in a scratch git worktree. Your tree is never touched.
3. It runs the defenders N times.
4. It re-runs survivors against the whole suite to name undeclared killers.
5. It restores the tree.
6. It classifies the result into one of seven
   [verdicts](verdicts.md#probe-verdicts).

TestGuard ranks findings by severity, claim provenance and blast radius. It
writes them as evidence, and validates the evidence against the spec before it
writes it.

| Flag | Default | Meaning |
|---|---|---|
| `--claims <path>` | `<dir>/testguard.claims.json` | Claims file. It may live outside the project (also for `claims`, `admit`, `status`). Fault `file` and `defendedBy` stay project-relative. The evidence records `run.claimsSource: {external, sha256}` and never the path. Nothing is written beside the file. |
| `--confirm <n>` | `3` | Runs per verdict. Below 3 the run is **provisional**: verdicts print with `?` and the evidence goes to `evidence-provisional.json`. |
| `--budget <ms>` | `120000` | Wall clock for each runner invocation. At least `1000`. A run that exceeds it is recorded `timeout` with `durationMs` of the budget. It has 5 seconds more to be killed (SIGKILL, whole process tree). After that, TestGuard destroys its output pipes and the run is over. So no run lasts longer than the budget plus 5 s. If TestGuard could not confirm the tree dead, the record's `detail.message` and one warning line say so. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole probe. It caps asynchronous children. When it expires, the probe exits `2` and writes no partial result, unless you give `--partial-on-budget`. At least `1000`. |
| `--partial-on-budget` | off | Needs `--command-budget` (exit `3` without it; also refused with `--require-origin`). When the budget runs out, TestGuard stops starting work, restores every tree, and writes the document anyway. Faults fully measured keep their record. The ones in flight or not started become `unverifiable` with reason `not-reached-within-budget` (they gate and are never reused). The document goes to `--out` or `.testguard/evidence-partial.json`, never the canonical file or a baseline. `run.budget` is `{limitMs, exhausted, reached, notReached}`. Exit `1` when the measured part already holds a gating finding (`--json`: `run.failureKind` `unproven+incomplete`, `run.unprovenAtLeast` a floor). Otherwise exit `2` (`incomplete`). Claims are probed in `--claim` order, so the caller decides what the budget buys first. `probe` only. |
| `--out <path>` | see below | Evidence file. |
| `--baseline <path>` | `<dir>/.testguard/baseline.json` if present | Baseline to gate against. |
| `--severity <level>` | `low` | Gate only findings whose claim severity is at or above this level. Findings below are still reported and written. |
| `--claim <ID,ID>` | every claim | Probe only these claims. Repeatable, order-preserving, duplicates collapsed. A confirmed run converges into `evidence.json`. Measured records replace the old ones. TestGuard carries the rest only when their inputs are unchanged (`carried`). A provisional, budget-cut, `--ref`, `--no-reuse` or `--out`-elsewhere run writes `evidence-partial.json` and says why. |
| `--changed <ref>` | none | `auto` finds the base offline. It tries the CI base branch, the remote default branch, a differently named upstream, then the branch's own upstream (the commits not pushed yet). With none, it probes every claim and says so. Otherwise, `probe` probes only the claims that the change since `merge-base(<ref>, HEAD)` can have affected. That means a fault's target, a defender, or anything they import differs (a rename counts through its old and new path; `--include-dirty` reads the working tree). It intersects with `--claim`. A confirmed run converges into `evidence.json` (TestGuard carries records it did not measure only when their inputs are unchanged). Otherwise it writes `evidence-partial.json`. A change git cannot measure (`ref-unresolved`, `no-merge-base`, `git-timeout`, `git-failed`) exits `2` and probes nothing. TestGuard never reads it as an empty change. Refused with `--ref` and `--in-place` (exit `3`). See [probing a change](../../spec/GATE-SEMANTICS.md#probing-a-change). |
| `--explain` | off | With `--changed`: print which claims the change selects and why, and probe nothing. The output has one line per selected claim with its reason, a count per reason kind, and the changed source files no claim covers. The reasons are: `file` (a target, defender, import or `testguard.config.json` changed); `glob` (only a `defendedBy` glob matches the changed path); `discovery` (a candidate test of a discovered defender set changed); `indeterminate` (the closure cannot be followed, with its first issue). `--json` gives `run.scope` exactly as a probe would, with `explain: true`, `probedCount` 0 and no `run.id`. Exit `0` for a determined change whatever it selects. Exit `2` when git cannot say what changed. Without `--changed`, exit `3`. |
| `--no-config` | off | Ignore [`testguard.config.json`](configuration.md#testguardconfigjson-how-this-projects-tests-run). Also on `admit`, `sweep`, `replay`, `claims` and `status`. Without it, every key the file sets is the default for the flag of the same meaning. A flag you type wins, then an environment variable. |
| `--when-no-base <full\|skip\|fail>` | `full` | With `--changed auto`, when no base can be resolved. `full` probes every claim and says so first. `skip` prints one line, measures and writes nothing, and exits `0` (the pre-push block passes it, so a hook never starts a full probe). `fail` exits `2` (error kind `no-base`). A base that was found but cannot be measured still exits `2`, and so does any runner failure. The flag is refused (exit `3`) without `--changed auto`, with any other value, and with `skip` and `--json`. |
| `--fail-on-empty-selection` | off | With `--changed`: a change that selects no claim exits `2` instead of `0`. Either way the run says so, probes nothing, writes no evidence and lists the changed source files no claim covers. Refused without `--changed` (exit `3`). |
| `--include-dirty` | off | Probe the working tree (snapshotted into a throwaway commit) instead of HEAD, so uncommitted tests count. |
| `--ref <commit>` | `HEAD` | Probe this commit in the scratch worktree. TestGuard honors it even when defender or target files are dirty. A warning names them, and the evidence records them as `repo.ignoredDirty`. |
| `--ignore-dirty` | off | Probe HEAD as committed although defender or target files are dirty (same warning and record). Without this flag, `--include-dirty` or an explicit `--ref`, TestGuard refuses a dirty defender or target. |
| `--in-place` | off | Mutate the working tree instead of a scratch worktree. Only fault target files must be clean. |
| `--runner <name>` | `auto` | Test runner. See the table below. |
| `--runner-cmd "<cmd>"` | none | A custom runner command. It must contain `{files}` and `{out}`, e.g. `"pnpm vitest run {files} --reporter=json --outputFile={out}"`. A reporter file path in it must start with `./` (or be absolute), because Node reads a bare `--test-reporter=tools/x.mjs` as a package name. |
| `--test-glob <glob>` | none | Repeatable. Needs `--runner-cmd`; without it the exit is `3`, because a built-in runner lists its own tests. It names the tests of a suite the built-in globs do not know (JUnit, Apex, MUnit), as a glob relative to the project, written with `/` (for example `"src/test/**/*Test.java"`). An absolute path, a backslash or a `..` segment exits `3`. The files a glob matches join the test universe that escalation asks, beside the built-in globs and every claim's declared defenders. `node_modules`, build output and the scratch directory are never searched. The globs are part of the universe hash, so a new or changed glob re-measures. Without this flag, escalation under `--runner-cmd` can only ask the tests that a claim declares. See [custom runners](languages-and-runners.md#custom-runners). Also the `testGlobs` key of [`testguard.config.json`](configuration.md#testguardconfigjson-how-this-projects-tests-run). |
| `--node-modules <dir>` | `TESTGUARD_NODE_MODULES` | `node_modules` to link into the scratch worktree when it cannot see yours. |
| `--scratch-dir <dir>` | `TESTGUARD_SCRATCH_DIR`, else the OS temp directory | An existing, writable directory for every scratch worktree, temporary git index, runner report and runner temp directory. A missing or unwritable directory exits 2 before anything is written. The flag bounds where TestGuard writes. It does not sandbox the tests. See [where TestGuard writes](configuration.md#where-testguard-writes). |
| `--typecheck[=<cmd>]` | off | Type check every fault before any test runs. Bare, the checker is the project's own `tsc --noEmit -p tsconfig.json --incremental`. TestGuard resolves it from the project or the linked `node_modules`, never a bundled compiler. A project with no `tsconfig.json`, or whose `typescript` does not resolve, needs `=<cmd>`. Otherwise the exit is `2`, and TestGuard never skips the check. TestGuard splits `<cmd>` into an argv like `--runner-cmd` and never runs it through a shell. Exit `0` means clean. Anything else is diagnostics, and the first line that says `error` is the message. TestGuard checks the unmodified tree first. If it is not clean, the exit is `2` naming the first diagnostic, and no evidence is written. A fault whose replacement does not type-check is `fault-invalid` / `replacement-does-not-typecheck` with zero test runs. A check over `--budget` is `timeout`. The program is the tsconfig's own, listed by `tsc --listFilesOnly`. A tsconfig whose program holds no project file (solution-style, references only) is exit `2`. The checker does not read some targets: `.py`; `.js` unless the tsconfig sets `allowJs` and `checkJs`; a `.ts` file the tsconfig does not include; and with `<cmd>`, every non-TypeScript file, since a command cannot say what it reads. TestGuard records these as `detail.typecheck: "not-applicable"` and probes them as before. The flag is recorded as `run.typecheck` and is part of the reuse key. Type validity belongs to the whole program. So TestGuard re-checks a reused record once (no test run), and carries it forward only if the answer is unchanged. A custom command's `version` is best-effort (its own `--version` plus the project's `typescript` when it resolves). Use `--no-reuse` if the checker can change without either changing. |
| `--python <path>` | `TESTGUARD_PYTHON`, then `$VIRTUAL_ENV`, then `.venv`, `venv`, `.env` in the project, then `python3`, `python` on `PATH` | Interpreter for `.py` defenders, resolved against your working tree. TestGuard looks up a bare name on `PATH`. An explicit interpreter is the only one tried. TestGuard never replaces it with another. |
| `--workers <n>` | `1` | Maximum built-in runner workers. Python stays serial. |
| `--serial` | off | One test process at a time. That means one runner worker even when `--workers` is higher (vitest `--no-file-parallelism`, jest `--runInBand`, playwright `--workers=1`; pytest always runs with `-p no:xdist`). It also means one fault at a time (`--fault-workers 1`). With `--fault-workers` above 1 it is a usage error. Use it only for a suite that cannot share the machine. |
| `--fault-workers <n\|auto>` | `auto` | Probe up to n faults at once, each in its own scratch worktree. `auto` is `min(4, floor(CPUs / 2))`, at least one, halved when other test runners are already running. `TESTGUARD_FAULT_WORKERS` sets it when the flag is absent. `--in-place` means one. TestGuard measures baselines once per defender set, with different sets side by side. Every kill rests on at least one probe run with no other fault in flight (`probeRuns[].alone`). Sometimes a run alone contradicts runs beside other faults. Then TestGuard marks the defender set `detail.notParallelSafe` and measures the fault again alone (`detail.remeasuredSerially`). It does the same for a contended timeout, inconsistent probe or suite-load failure. Records keep claim/fault order. TestGuard records `run.faultWorkers` (above one), `run.faultWorkersSource` and, for auto, `run.cpus`. See [performance](../guides/performance.md#probe-several-faults-at-once). |
| `--no-escalate` | off | Do not re-run survivors against the whole suite. Escalation runs the whole suite up to N times per survivor. |
| `--no-reuse` | off | Re-probe claims whose recorded inputs have not changed. |
| `--allow-empty` | off | Adoption only: a valid claims file with zero claims exits `0` instead of `2`, writes no evidence, and says verification was skipped. Has no effect with `--claim`. |
| `--require-assertion-kill` | off | Fail (exit 1) when an uncaught exception alone made any kill and no assertion did, or when the kill comes from evidence that records no kind. The verdict stays `killed`. The policy names the faults and is stored as `assertionPolicy`. Also valid on `admit`, where it refuses a test whose kills are all exception-only. A kill whose runner reported no error identity fails with `reason: "kind-not-reported-by-runner"`, per kill, in the text line and in `--json`. Only a runner that reports identity can satisfy this policy. The built-in runners do. A custom `--runner-cmd` can if it writes a jest-shaped report (`testResults[].assertionResults[]`) with `failureDetails` per failed test: `matcherResult`, or `name: "AssertionError"`, or `code: "ERR_ASSERTION"`, or an `operator`. Without `failureDetails`, every failure is an exception and the policy cannot pass. |
| `--require-origin <kinds>` | none | Require every claim's declared source kind to be in this set (repeatable, comma-separated). Needs a complete confirmed run. It is refused with `--claim`, `--allow-empty`, `--ref`, `--ignore-dirty` or `--confirm` below 3. Labels do not authenticate independence. |
| `--progress <mode>` | `auto` | `auto`, `tty`, `plain`, `ndjson` or `none`. Always on stderr. `--quiet` and `--json` imply `none` unless this is given explicitly. |
| `--verbose` | off | Also print every killed fault. |
| `--quiet` | off | Print only the summary and the evidence path. |
| `--cost` | off | Also report what this run's defenders cost. |
| `--json` | off | Print the status document plus this run's result. |

Where the evidence goes, unless `--out` says otherwise:

| Run | File |
|---|---|
| Complete, `--confirm` 3 or more | `.testguard/evidence.json` |
| `--claim` or `--changed` selection | `.testguard/evidence-partial.json` |
| `--confirm` below 3 | `.testguard/evidence-provisional.json` |

Partial and provisional runs never overwrite the canonical evidence. Only a
confirmed, complete run may feed a baseline.

| `--runner` | What runs |
|---|---|
| `auto` | The first of `vitest`, `jest`, `python` that resolves and discovers at least one test file. A defender under Playwright's `testDir` always runs under `playwright`, and a `.py` defender always under `python`, whatever the project runner. |
| `vitest` | Vitest, resolved from the project's own package first. |
| `jest` | Jest, resolved the same way. |
| `playwright` | Playwright Test. |
| `python` | pytest when the interpreter can import it, stdlib `unittest` otherwise. |
| `pytest` | pytest, and fail rather than fall back. |
| `unittest` | stdlib `unittest`, and fail rather than fall back. |
| `node-test` | Node's built-in test runner, using the Node executable running TestGuard. Explicit only. `auto` never picks it. |

[Languages and runners](languages-and-runners.md) covers detection, limits and
per-runner behavior.

**Exit:**

- `0`: no new gating finding at or above the severity floor.
- `1`: at least one new finding, a failed `--require-origin` policy, or a
  failed `--require-assertion-kill` policy. Baseline debt and severity floors
  cannot hide these policy failures.
- `2`: a precondition failed. Examples: an empty claims file without
  `--allow-empty`, a runner that does not resolve, a dirty defender or target
  with the implicit HEAD, an exhausted command budget (without
  `--partial-on-budget`), an unavailable origin policy, a `--changed` change
  git could not measure, or an empty `--changed` selection under
  `--fail-on-empty-selection`.
- `3`: usage. Examples: `--confirm` not a positive integer, `--budget` or
  `--command-budget` below 1000, `--workers` or `--fault-workers` not a positive
  integer, `--fault-workers` above 1 with `--in-place`, an unknown `--progress`
  mode, an empty `--claim`, `--fail-on-empty-selection` without `--changed`, or
  `--partial-on-budget` without `--command-budget` or with `--require-origin`.

With `--partial-on-budget`, an exhausted command budget writes a document instead of refusing. The exit is `1` when the measured part already holds a gating finding, otherwise `2` (see the flag above). It is never `0`.

**`--json` schema:** [`status.schema.json`](../../spec/schemas/status.schema.json),
with `run` = `{id, evidence, provisional, records, newSinceBaseline, exitCode, claims, originPolicy?, scope?, budget?, failureKind?, unprovenAtLeast?}`
and `cost` when `--cost` is given. `budget` = `{limitMs, exhausted, reached, notReached}` is present with `--partial-on-budget`. `failureKind` (`unproven+incomplete`, `policy+incomplete` or `incomplete`) and `unprovenAtLeast` (a floor) are present only when the budget ran out. `run.claims[]` is `{id, result: "proven" | "unproven" | "could-not-verify", faults: {total, killed, survived, nocover, unverifiable, faultInvalid, timeout, flakyDefender}, reasons: [{faultId, verdict, reason?}]}` per claim measured, keyed by claim id ([per-claim results](../../spec/GATE-SEMANTICS.md#per-claim-results)). With `--changed`, `run.scope` adds `selectedCount` and `changed` = `{ref, outcome: "determined" | "undetermined", base, head, includeDirty, files, matchedClaims, unmatchedFiles, note}` (or `{ref, outcome: "undetermined", reason: {kind, message}}`). When the selection is empty or undetermined, no probe ran and `run` is only `{exitCode, scope}`. The evidence file itself conforms to
[`evidence.schema.json`](../../spec/schemas/evidence.schema.json).

**A scoped run has two answers.** The status header (`state`, `next`) is about the whole claims file. A broken anchor on a claim you did not select is visible there. A `--claim` or `--changed` run also reports `run.scope.state` and `run.scope.next`. This is the same state machine over only the probed claims and their evidence, and a `target` it names is always a probed claim. The human output leads with a `scope:` line for the selection. Then it prints a `rest of the file:` line when the whole file says something different. Act on the scoped view to finish your selection. The whole-file state is what a full `probe` or `status` would report.

## baseline

```bash
npx testguard-cli baseline [dir] [--evidence <path>] [--out <path>] [--allow-provisional] [--restamp] [--json]
```

This command freezes the fingerprint of every non-passing finding in the
evidence. Later probes suppress what was already known and exit non-zero only
on what is new. It prints the `.gitignore` lines for any regenerated output
that git does not yet ignore. Commit the baseline it writes.

| Flag | Default | Meaning |
|---|---|---|
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Evidence to freeze. |
| `--out <path>` | `<dir>/.testguard/baseline.json` | Baseline to write. |
| `--allow-provisional` | off | Freeze evidence from a run with `--confirm` below 3. Normally refused. |
| `--restamp` | off | Move an existing baseline's `head` to the commit of a later, clean probe that reproduced exactly the same fingerprints. A baseline frozen from `--include-dirty` evidence points at the parent of the commit that carries its tests. After you commit, `--restamp` moves it. |
| `--json` | off | Print the status document plus `baseline: {path, frozen}` (or `{path, restamped}`). |

**Exit:** `0`. `2` when there is no evidence, when the evidence is provisional
without `--allow-provisional`, or when `--restamp` cannot apply (no baseline
yet, evidence from a dirty tree or snapshot, or different fingerprints).

**`--json` schema:** [`status.schema.json`](../../spec/schemas/status.schema.json),
with `baseline` = `{path, frozen}` or `{path, restamped}`. TestGuard validates
the document before it prints it. The baseline file conforms to
[`baseline.schema.json`](../../spec/schemas/baseline.schema.json).

## brief

```bash
npx testguard-cli brief [dir] [--text | --markdown] [--max <n>] [--evidence <path>] [--baseline <path>] [--json]
```

This command turns evidence plus baseline into a ranked, capped
`## TEST BLINDSPOT CONTEXT` block. The block starts with the next action and
the unclaimed changed files. Without `--text` or `--markdown`, it also writes
`.testguard/brief.json`. The first line says which install answered
(`local install`, `npx cache`, `pnpm dlx cache`, `bunx cache` or `global`), so
you can see a stale install.

| Flag | Default | Meaning |
|---|---|---|
| `--text` | off | Print only; write nothing. With no evidence, it prints the unclaimed changes, if any. Otherwise it exits `0` silently. The session-start hook uses this form. |
| `--markdown` | off | Print only, rendered as a merge-request note for a human reviewer, with unclaimed changes first. Same silence rule as `--text`. |
| `--max <n>` | `20` | Items in the brief, 1 to 50. |
| `--evidence <path>` | `<dir>/.testguard/evidence.json` | Evidence to brief from. |
| `--baseline <path>` | `<dir>/.testguard/baseline.json` if present | Baseline that marks findings as known. |
| `--json` | off | Print the brief document. |

**Exit:** `0`. `2` when there is no evidence and you gave neither `--text` nor
`--markdown`. `3` when `--max` is outside 1–50.

The brief carries the status document's `advice` (as `SPEED:` lines in text,
a "Go faster" list in markdown).

**`--json` schema:** [`brief.schema.json`](../../spec/schemas/brief.schema.json).

## gate

```bash
npx testguard-cli gate [dir] [--changed <ref>] [--include-dirty] [--exclude <glob>]... [--strict] [--ignore <path>] [--json]
npx testguard-cli gate --explain
```

This command measures claim coverage of a change. Every changed source file
must carry a fault, resolve as a defender of a claim (test files), or be
excused by an unexpired `path` entry in the ignore file. One unclaimed file
fails. There is no percentage. TestGuard prints every reliance on an ignore
entry, and an expired entry excuses nothing. The command always writes
`.testguard/gate.json`.

| Flag | Default | Meaning |
|---|---|---|
| `--changed <ref>` | detected | Measure the change since `merge-base(ref, HEAD)`. |
| `--include-dirty` | off | Compare the working tree (staged, unstaged, untracked) instead of HEAD. The pre-commit shape is `gate --changed HEAD --include-dirty`. |
| `--exclude <glob>` | none | More files that never carry claims. Repeatable. |
| `--explain` | off | Print the default exclusions and exit `0`. |
| `--strict` | off | A non-empty change that evaluates nothing is a failure, not a note. |
| `--ignore <path>` | `<dir>/testguard.ignore.json` | Ignore file. Only its `path` entries apply here. See [the ignore file](configuration.md#ignore-file). |
| `--claims <path>` | `<dir>/testguard.claims.json` | Claims file. |
| `--out <path>` | `<dir>/.testguard/gate.json` | Gate document. |
| `--quiet` | off | Omit the `gate: <path>` line and the "comparing against" note. |
| `--json` | off | Print the gate document. |

When `--changed` is absent, TestGuard detects the reference. The first match
wins: `TESTGUARD_CHANGED_REF`; `GITHUB_BASE_REF` (as `origin/<branch>`);
`CI_MERGE_REQUEST_DIFF_BASE_SHA`; `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (as
`origin/<branch>`); then, in an ordinary clone on a branch, the remote's
symbolic default branch, or a configured upstream whose branch name differs
from the current one. TestGuard never picks a same-name tracking branch,
because it would produce a misleading empty diff. The gate says which
reference it chose.

Source files are `.js .mjs .cjs .ts .mts .cts .jsx .tsx .py`. The gate
treats a changed file in a language it cannot probe (for example `.cls`,
`.java`, `.dwl`) as a gap: it is listed as `unsupported-language`, and
`--strict` fails on it unless an ignore entry excuses it. Every other file is
non-source. The default exclusions (`--explain`) are
`**/*.d.ts`, `**/*.config.*`, `**/*.stories.*`, `**/*.generated.*`,
`**/fixtures/**`, `**/__fixtures__/**`, `**/__mocks__/**`,
`**/__snapshots__/**` and `.testguard/**`. A directory with its own valid
`testguard.claims.json` is a nested project. The gate reports its files as
delegated and does not count them as coverage here (see the
[monorepo guide](../guides/monorepo.md)).

**Exit:**

- `0`: every changed source file is claimed or excused.
- `1`: an unclaimed file, or `--strict` with nothing evaluated.
- `2`: the gate cannot evaluate (the reference does not resolve, or the claims
  or ignore file is invalid).
- `3`: no reference could be found.

**`--json` schema:** [`gate.schema.json`](../../spec/schemas/gate.schema.json).

## scaffold

```bash
npx testguard-cli scaffold <source-file> [--claim <ID>] [--claims <path>] [--out <path>] [--json]
npx testguard-cli scaffold <source...> --into <draft.json> --claim <ID> [--json]
npx testguard-cli scaffold --from-document <local-text-path> [--json]
npx testguard-cli scaffold --from-fix <full-commit-ID> [--json]
```

This command proposes faults mechanically. It writes exact anchors, computes
`expectHits` from the file, prefills `defendedBy` from the tests that import
the module, and adds `TODO` statements. The output is a draft, never your
claims file. A proposal becomes a claim only when a person states what it
defends. Run it from the project directory. The project is the current
directory, and the source path must be inside it. [Writing claims](../guides/writing-claims.md)
lists the fault shapes it proposes.

| Mode | Flags | What it does |
|---|---|---|
| One file | `--claim <ID>` (put every proposal under this claim; copies it from the claims file if it exists), `--claims <path>`, `--out <path>` | Writes `.testguard/scaffold-<basename>.json`. With `--json`, prints the draft and writes nothing. |
| Append | `--into <existing-draft.json>` and exactly one `--claim <ID>` that exists in the draft; one or more sources | Appends proposals to a draft you have already given intent to. `--json` previews without writing. No other options are accepted. TestGuard refuses canonical claims, evidence and baseline paths. |
| Input inspection | exactly one of `--from-document <path>` or `--from-fix <sha>`; only `--json` alongside | Read-only, stdout only, metadata only: it never prints document text. `--from-fix` needs a full lowercase SHA-1 or SHA-256 commit ID with exactly one parent. It does not perform verification. |

**Exit:** `0`. `2` when the file does not exist or is outside the project, or
when an append or input inspection was refused. `3` for usage errors: no
source, more than one source without `--into`, a repeated or comma-separated
`--claim`, or a conflicting option.

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

This is the cold start: no claim needed. The command takes the changed source
files that carry no claim. It proposes faults with the same producers as
`scaffold`. It probes a bounded selection, ordered by how productive each fault
class has been in this repository. Then it reports what a green suite did not
notice. It never writes `testguard.claims.json`, and its evidence never
replaces `.testguard/evidence.json`.

| Flag | Default | Meaning |
|---|---|---|
| `--changed <ref>` | detected (as for [gate](#gate)) | The change to sweep. Required unless `--save-paths` or `--concern` is given. |
| `--save-paths` | off | Sweep every file that writes to storage instead of the diff, and report that surface as the denominator. A shorthand for the built-in `SAVE-PERSISTS` concern. |
| `--concern <ID>` | none | Aim the sweep by one concern: its targets and its fault classes. `concerns` lists them. |
| `--concerns <path>` | `<dir>/testguard.concerns.json` | A custom concerns file. |
| `--cap <n>` | 7 per target file (at least 7) | Faults to probe. The rest are reported as deferred, not as a verdict. |
| `--include-dirty` | off | Measure the working tree instead of HEAD. |
| `--exclude <glob>` | none | More files to leave out. Repeatable. |
| `--confirm <n>` | `3` | Runs per verdict. |
| `--budget <ms>` | `120000` | Wall clock per runner invocation. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole sweep. When it expires, the sweep exits `2` and writes nothing. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One worker, even when `--workers` is higher. |
| `--runner`, `--runner-cmd`, `--test-glob`, `--node-modules` | as for [probe](#probe) | Runner selection. `--test-glob` needs `--runner-cmd`. |
| `--python <path>` | as for [probe](#probe) | Interpreter for `.py` defenders (or `TESTGUARD_PYTHON`). |
| `--claims <path>`, `--ignore <path>` | project defaults | Files used to decide which changed files are unclaimed. |
| `--max <n>` | `20` | Findings printed in the text report. |
| `--out <path>` | `<dir>/.testguard/sweep.json` | Sweep document. |
| `--quiet` | off | Omit warnings and the `sweep: <path>` line. |
| `--json` | off | Print the sweep document. |

**Exit:** `0` when nothing survived. `1` when a fault survived or a swept file
has no test that imports it (`survived` or `nocover`; see
[sweep exit semantics](verdicts.md#sweep)). `2` when the sweep cannot evaluate,
including a concerns file that is not valid JSON or does not conform. `3` when
there is no reference, `--cap` is not a positive integer, or `--concern` is
unknown.

**`--json` schema:** [`sweep.schema.json`](../../spec/schemas/sweep.schema.json).

## concerns

```bash
npx testguard-cli concerns [dir] [--concerns <path>] [--json]
```

This command lists the concerns that can aim a sweep. First come the project's
own, from `testguard.concerns.json`. Then come the two built-ins
(`SAVE-PERSISTS`, `CHANGED-CODE`) that the project has not replaced. The
command validates the file and reports a replaced built-in. A concern is a
scope, never a claim. The file format is in
[configuration](configuration.md#concerns-file).

| Flag | Default | Meaning |
|---|---|---|
| `--concerns <path>` | `<dir>/testguard.concerns.json` | Read this concerns file instead. |
| `--json` | off | Print `{schemaVersion, tool, source, shadowed, concerns}`. |

**Exit:** `0`. `2` when the file is not valid JSON or does not conform to the
schema (the message names the file and the error). No exit code means that
something is wrong with the project.

**`--json` schema:** none published for the listing; the file itself conforms
to [`concerns.schema.json`](../../spec/schemas/concerns.schema.json).

## mcp

```bash
npx testguard-cli mcp
```

This command serves five read-only tools over the Model Context Protocol
(JSON-RPC 2.0, newline-delimited, on stdio). So the operating loop works in any
agent harness. No tool runs a probe or writes a file. The
[MCP reference](mcp.md) covers tools, inputs and setup.

It takes no options. It refuses `--json` with exit `3`. Otherwise it runs
until stdin closes and exits `0`.

## replay

```bash
npx testguard-cli replay [dir] --since <range> [--max <n>] [options]
```

A fix commit is one that changes source and a test together. For each fix
commit in the range, `replay` does these steps:

1. It checks the commit out in a scratch worktree.
2. It reverts only the source files to the parent.
3. It deletes the test the fix shipped.
4. It runs the tests that import the reverted code.

One patch counts once (`git patch-id`). The command writes a replay document
and, beside it, a calibration document: per fault class, how often the suite
missed a real escaped bug of that class. It reports and never gates. See the
[replay guide](../guides/replay.md).

| Flag | Default | Meaning |
|---|---|---|
| `--since <range>` | required | Commit range to search: `HEAD~50..HEAD`, a tag, `origin/main..HEAD`. `--changed <range>` is accepted as an alias. |
| `--max <n>` | `20` | Replay at most this many fix commits. Each costs a worktree and N runs. |
| `--confirm <n>` | `3` | Runs per verdict. Mixed runs are never `caught`. |
| `--budget <ms>` | `120000` | Wall clock per run. |
| `--command-budget <ms>` | none | Cooperative deadline. When it expires, `replay` writes neither the replay nor the calibration. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One worker, even when `--workers` is higher. |
| `--runner`, `--runner-cmd`, `--test-glob`, `--node-modules` | as for [probe](#probe) | Runner selection. `--test-glob` needs `--runner-cmd`. |
| `--python <path>` | as for [probe](#probe) | Interpreter for `.py` defenders (or `TESTGUARD_PYTHON`). |
| `--out <path>` | `<dir>/.testguard/replay.json` | Replay document. The calibration is written as `calibration.json` in the same directory. |
| `--calibration-out <path>` | beside the replay document | Write the calibration document to this path instead. |
| `--json` | off | Print `{replay, calibration, paths}`. |

`replay` has no `--baseline`. A baseline gates probe findings, and replay
never gates. If you pass it, the command exits `3` and names `--calibration-out`.

**Exit:** `0` whatever the verdicts. `2` when the range holds no fix commits
or another precondition fails. `3` when `--since` is missing, a number is
malformed, or `--baseline` is given.

**`--json` schema:** the two documents conform to
[`replay.schema.json`](../../spec/schemas/replay.schema.json) and
[`calibration.schema.json`](../../spec/schemas/calibration.schema.json).

## admit

```bash
npx testguard-cli admit <test-file> --claim <ID> [--fault <FID>] [--confirm <n>] [--json]
```

`admit` is the two-gate rule as one command. Is this test green on unmodified
HEAD? Does it fail on every fault of the claim, N/N? The command is a
shorthand for `probe --claim <ID> --include-dirty --no-escalate`, so it can
never disagree with the gate. The test may be uncommitted. The project is the
nearest directory above the test file that holds `testguard.claims.json` (or
the directory of `--claims`).

| Flag | Default | Meaning |
|---|---|---|
| `--claim <ID>` | required | Exactly one claim. |
| `--fault <FID>` | every fault of the claim | Admit against one fault only. |
| `--confirm <n>` | `3` | Runs per verdict. Below 3 the answer is `ADMITTED?`, provisional. |
| `--budget <ms>` | `120000` | Wall clock per runner invocation. |
| `--command-budget <ms>` | none | Cooperative deadline for the whole admission. |
| `--workers <n>` | `1` | Maximum built-in runner workers. |
| `--serial` | off | One worker, even when `--workers` is higher. |
| `--claims <path>` | found from the test file | Claims file; its directory is the project. |
| `--out <path>` | `<project>/.testguard/evidence-partial.json` | Evidence file. Never the canonical one. |
| `--runner`, `--runner-cmd`, `--test-glob`, `--node-modules` | as for [probe](#probe) | Runner selection. `--test-glob` needs `--runner-cmd`. |
| `--python <path>` | as for [probe](#probe) | Interpreter for `.py` defenders (or `TESTGUARD_PYTHON`). |
| `--quiet` | off | Suppress progress and the provisional warning. |
| `--json` | off | Print `{admitted, provisional, claim, test, faults, evidence, command}`. |

**Exit:** `0` ADMITTED. `1` NOT ADMITTED, naming the first blocking fault and
what to do about it. `2` when the file does not exist, the claim or fault is
unknown, or another precondition failed. `3` for a usage error, or when the
test is not a declared or discovered defender of the claim (the message says
how to declare it). [Verdicts](verdicts.md#admit) explains what the answers
mean.

**`--json` schema:** none published for the result; the evidence file conforms
to [`evidence.schema.json`](../../spec/schemas/evidence.schema.json).

## clean

```bash
npx testguard-cli clean [dir] [--dry-run] [--scratch-dir <dir>] [--json]
```

This command removes what interrupted runs left under the scratch directory
(the operating system's temp directory unless `--scratch-dir` or
`TESTGUARD_SCRATCH_DIR` names one). It says how much it freed. It removes
these:

- **scratch trees** (`testguard-*` worktrees and runner directories) whose owner
  is gone. Every tree carries an owner record (the creating process and host,
  and the repository it is registered with). A tree is an orphan when that
  process is no longer running on this host. A tree with no owner record (one a
  version before 0.26 left) is removed only when it is older than 24 hours;
- **stale locks**: worker-slot and worktree-allocation lock files whose owner is
  gone;
- **stale `git worktree` registrations** of the repository `[dir]` is in (never
  another repository's).

The command never touches these: a tree whose owner is alive, a tree another
host owns, a young tree with no owner record, and any directory this tool does
not name that way. `probe`, `sweep`, `replay` and `admit` do the same cleanup
before they start. It is bounded to a few seconds, and they print one line when
they removed something. A cleanup that fails gives one warning and never fails
the command. `status` and `brief` carry an `orphaned-scratch` advice line with
this command when there is something to remove.

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | List what would be removed and remove nothing. |
| `--scratch-dir <dir>` | the OS temp directory | The scratch root to clean, as for [probe](#probe). |
| `--json` | off | One document: `{base, dryRun, capped, removed[{kind, path, reason, bytes}], failed, worktrees, bytes}`. |

**Exit:** `0`, also when there was nothing to remove. `2` when an entry could
not be removed.

## Next

- [Verdicts and signals](verdicts.md): what each verdict and signal in the output means.
- [Configuration](configuration.md): the claims, ignore and concerns files and the environment variables.
- [Artifacts](artifacts.md): every file under `.testguard/`, and which to commit.
- [How it works](../concepts/how-it-works.md): the loop these commands form.
