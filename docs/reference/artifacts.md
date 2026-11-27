# Artifacts reference

This page lists every file TestGuard writes. For each file it says which
command writes it, which schema validates it, and whether it belongs in git.
Use it to set up `.gitignore`, to wire CI artifacts, or to read TestGuard's
output with another tool. TestGuard validates every JSON document below against
its schema before it writes the document. So a file on disk always has the
shape you expect.

## The rule: commit the baseline, ignore the rest

The baseline is the frozen contract: it records which findings were already
known when you adopted a gate. Commit it. A CI run on a fresh clone needs it to
tell new findings from old ones. A run regenerates everything else under
`.testguard/`, and each file describes one moment. So it does not belong in
history.

`testguard init` appends these lines to the project's `.gitignore`:

```gitignore
# TestGuard: regenerated per run (baseline.json IS committed)
.testguard/evidence.json
.testguard/evidence-provisional.json
.testguard/evidence-partial.json
.testguard/brief.json
.testguard/gate.json
.testguard/scaffold-*.json
.testguard/replay.json
.testguard/calibration.json
.testguard/ci-self-evidence.json
.testguard/ci/
.testguard/sweep.json
.testguard/sweep-evidence.json
```

Run `init` again after an upgrade to add the lines a newer release introduced.
It adds only those lines, directly after the ones already there. The block
never gains a second header. A test checks this list against the code. It
derives every path a command writes under `.testguard/`, and it fails when one
is missing here.

`testguard baseline` prints whichever of those lines git does not yet ignore.
It also offers the form that needs no update when TestGuard adds an output.
Both forms ignore exactly the same files. Both leave the same three files
trackable:

```gitignore
.testguard/*
!.testguard/baseline.json
!.testguard/status.json
!.testguard/fetch-ci-evidence.sh
```

If `.gitignore` already uses the `.testguard/*` form, `init` adds nothing. If
it ignores `.testguard/` as a whole, `init` leaves it alone and warns that
`baseline.json` should be committed.

## Files under `.testguard/`

| File | Written by | Schema | Git |
|---|---|---|---|
| `evidence.json` | `probe` (complete run, `--confirm` 3 or more) | [`evidence`](../../spec/schemas/evidence.schema.json) | ignore |
| `evidence-provisional.json` | `probe --confirm` below 3 | [`evidence`](../../spec/schemas/evidence.schema.json) | ignore |
| `evidence-partial.json` | `probe --claim`, `probe --changed`, `admit`, and an exhausted `probe --partial-on-budget` | [`evidence`](../../spec/schemas/evidence.schema.json) | ignore |
| `baseline.json` | `baseline` | [`baseline`](../../spec/schemas/baseline.schema.json) | **commit** |
| `brief.json` | `brief` (not with `--text` or `--markdown`) | [`brief`](../../spec/schemas/brief.schema.json) | ignore |
| `gate.json` | `gate` | [`gate`](../../spec/schemas/gate.schema.json) | ignore |
| `scaffold-<basename>.json` | `scaffold <file>` | [`claims`](../../spec/schemas/claims.schema.json) | ignore |
| `sweep.json` | `sweep` | [`sweep`](../../spec/schemas/sweep.schema.json) | ignore |
| `sweep-evidence.json` | `sweep`, only when it probed something | [`evidence`](../../spec/schemas/evidence.schema.json) | ignore |
| `replay.json` | `replay` | [`replay`](../../spec/schemas/replay.schema.json) | ignore |
| `calibration.json` | `replay`, beside the replay document | [`calibration`](../../spec/schemas/calibration.schema.json) | ignore |
| `fetch-ci-evidence.sh` | `init --ci-evidence github\|gitlab` | shell script | **commit** |
| `ci/` | `fetch-ci-evidence.sh` (download directory) | n/a | ignore |
| `ci-self-evidence.json` | your CI, by convention (see below) | [`evidence`](../../spec/schemas/evidence.schema.json) | ignore |
| `status.json` | no command writes it | [`status`](../../spec/schemas/status.schema.json) | not ignored by either form; commit it if you keep one |

Every path above is the default. The commands that write a document take
`--out <path>` to put it elsewhere.

### evidence.json

This file holds one run's findings. It has every verdict, with every baseline
run and probe run that produced it. It also has the resolved defenders, the
files that mock the subject, the input hashes that make verdict reuse sound,
and the rank. It is the canonical evidence: `status`, `baseline`, `brief` and
the MCP tools read it. Only a complete, confirmed run writes it. A provisional
or partial run goes to its own file, so it can never be frozen into a baseline
by accident.

The next `probe` reads its own output file. It reuses verdicts whose recorded
inputs have not changed (`--no-reuse` turns that off). Those inputs include:

- `inputs.dependencyHashes`: the hashes of everything the target and its
  defenders import, plus the root lockfiles and runner config.
- `inputs.dependencyClosure`: `complete`, or `indeterminate` when an import
  could not be followed. The reasons are in `inputs.dependencyIssues`.

TestGuard never reuses an indeterminate record, or one written before these
fields existed. Before it reuses any record, its defender set runs once,
unmodified. `run.measurements.reuseBaselineRuns` counts those runs.
`run.instrument` names the TestGuard version and a digest of the resolver and
runner configuration. TestGuard never reuses evidence from another version or
digest. `run.reuse` counts the records carried forward and the records
measured.

With `probe --typecheck`, `run.typecheck` names the checker (`commandHash` of
the command's identity, and its `version`). Each record says how its fault was
judged in `detail.typecheck`: `clean`, `diagnostics`, `timeout` or
`not-applicable`. The type check is part of the reuse key. A run with it never
reuses a record measured without it, and the reverse is also true. Reuse
trusts this file. If the people a gate judges can write it, run that gate with
`--no-reuse`.

TestGuard writes the file atomically (a temporary file, then a rename). An
interrupted run never leaves a truncated document behind.

**For tools that read this file.** `inputs.targetHash` and
`inputs.defenderHashes` are unchanged. `inputs.dependencyHashes` was added
beside them. To judge whether a record is still fresh, a consumer must compare
all three against the current tree. The first two alone miss a changed helper
that the target or a defender imports.

### External claims files

Sometimes `--claims` names a file outside the project. Then every evidence
document it produces carries `run.claimsSource: { external: true, sha256 }`.
It records nothing else about the file, and no path. `status` reports the same
`claimsSource` and omits `paths.claims`. Records stay self-describing: each one
embeds the claim id, statement, severity and source. So a consumer without the
claims file can read results per claim id. It cannot check `claim-changed`
against the file. The project's own claims file has no `claimsSource`.

### evidence-provisional.json and evidence-partial.json

`probe --confirm 1` or `2` writes the provisional file. `baseline` refuses it
unless you pass `--allow-provisional`. `probe --claim <ID>`, `probe --changed <ref>` and `admit` write
the partial file. Neither file ever replaces `evidence.json`.

A `probe --partial-on-budget` whose command budget ran out also writes the partial
file (or `--out`), never the canonical one. It records `run.budget`
(`{limitMs, exhausted, reached, notReached}`). Every fault the budget did not reach is an
`unverifiable` record with reason `not-reached-within-budget`. `baseline` refuses such a document. A later
probe never reuses one of those records.

### baseline.json

The baseline holds the fingerprint of every non-passing finding at freeze time.
It also has a count, the commit it was taken at, and the snapshot commit when
the evidence came from `--include-dirty`. A fingerprint is `sha256(claimId \n subjectId \n file \n verdict)`.
It comes from identity and outcome, never from the fault's text. So repairing a
rotted anchor does not change it.

### brief.json

This file holds the same ranked, capped block that `brief` prints, as text and
as structured items. The session-start hook uses `brief --text`, which prints
and writes nothing.

### gate.json

This file holds the claim coverage of one change. It lists the files that are
changed, evaluated, excluded, covered and uncovered. It also lists the files
delegated to nested projects, the ignore entries relied on, the expired ones,
and the exit code.

### Scaffold drafts

A scaffold draft is a draft claims document for one source file. It is named
after the file's basename without the extension (`src/auth.ts` gives
`scaffold-auth.json`). It is never your claims file: statements are `TODO`
placeholders. Move the claims you keep into `testguard.claims.json` by hand.

### sweep.json and sweep-evidence.json

`sweep.json` holds what the sweep covered, the selection arithmetic, the
findings and the draft claims documents the proposals came from (`drafts`). You
can keep a draft without re-running the sweep. `sweep-evidence.json` holds the
probed records. The next sweep reads it, and `evidence.json`, to learn which
fault classes are productive in this repository. TestGuard writes it only when
something was probed. An empty document would teach the next run that every
class is unproductive.

### replay.json and calibration.json

The replay document lists each replayed fix commit with its verdict. The
calibration document gives, per fault class, the share of real escaped bugs
that the suite missed. It also gives a Wilson interval and the sample size. The
validator recomputes every number. `replay --out` moves both into the same
directory.

### fetch-ci-evidence.sh

`init --ci-evidence` writes this on-demand helper. It runs from the project it
was written into, whatever directory you call it from. It does these steps:

1. It empties `.testguard/ci/`.
2. It downloads CI's evidence for a branch (default `main`, or the first
   argument) into that directory.
3. It runs `brief . --text --evidence <file>` on this project's evidence file in
   that directory (see the table).

It uses the same CLI the session-start hook would: `./node_modules/.bin/testguard`, then the repository root's
`node_modules/.bin/testguard`, then a `testguard` on `PATH`. It never uses a
package runner. It exits `0` with a message when the platform CLI, a TestGuard
CLI, the artifact or an evidence file in it is missing. It is not a hook: the
session-start hook never touches the network.

| Variant | Needs | Downloads | Briefs from |
|---|---|---|---|
| `github` | `gh` | the artifact named `testguard-evidence-<branch>` | `.testguard/ci/evidence.json`, else `evidence-provisional.json`, else `ci-self-evidence.json` |
| `gitlab` | `glab` | the artifacts of the `testguard:probe` job | `.testguard/ci/<dir>/.testguard/evidence.json` (`<dir>/` is empty for a project at the repository root), else `evidence-provisional.json` beside it |

The `gitlab` variant matches the artifacts of the
[GitLab CI template](../guides/ci/gitlab.md). The `github` variant matches the
default-branch workflow in [GitHub Actions](../guides/ci/github-actions.md).
That workflow uploads the file that the action's `evidence` output names, under
that name. The action does not upload an artifact by itself. The GitLab helper
of a subdirectory project never reads another project's evidence from the same
artifact.

### status.json

This name is reserved for a snapshot of the status document. No command writes
it, and no ignore form that TestGuard suggests ignores it. The per-file lines
from `init` never name it, and the `.testguard/*` form that `baseline` advises
negates it. To put a snapshot under review, write it yourself with
`npx testguard-cli status --json > .testguard/status.json` and commit it. It
describes the moment you wrote it. Refresh it in the same commit as the change
it describes.

### Files written outside `.testguard/`

| File | Written by | Git |
|---|---|---|
| `.claude/skills/testguard/SKILL.md`, `.claude/settings.json` (hook), `AGENTS.md` section | `init`, at the git root (or `[dir]` with `--here`) | commit |
| `.gitignore` lines | `init`, in `[dir]` | commit |
| `@claim` file-header comments | `claims --annotate --apply` | commit |
| a draft passed to `--into` | `scaffold --into` | your choice |
| `.testguard/brief.md`, `.testguard/post-note.mjs` | the GitLab CI template's probe job | CI artifacts only |

`claims --annotate --apply` and `scaffold --into` keep recovery copies of the
originals in an owner-only directory outside the checkout. They report its
location.

While either command writes, it holds `.testguard-annotations.lock` in the
project directory. This is an exclusive, owner-only file that names the process
holding it. A second writer refuses with `annotation authoring lock already exists`
and does not wait. TestGuard never removes a lock it does not own. A lock left
by an interrupted run stays until you delete it. Before you delete it, check
that no TestGuard process is still running.

## Schemas

The shared formats live in [`spec/schemas/`](../../spec/schemas/). They are JSON
Schema 2020-12, and they are identified as `urn:claimspec:v1:<kind>`. The
validator is [`spec/lib/validate.mjs`](../../spec/lib/validate.mjs). It applies
each schema. Then it applies the rules a schema cannot express, such as unique
IDs, fingerprint derivation, N-run agreement and interval arithmetic.

| Schema | What it describes |
|---|---|
| [`annotations`](../../spec/schemas/annotations.schema.json) | The `claims --annotate` preview or apply result: targets, refusals and recoverable partial failures. It supports authoring, never verification. |
| [`error`](../../spec/schemas/error.schema.json) | What a command writes to stdout under `--json` when it refuses (exit 2) or you invoke it wrongly (exit 3): `{kind, message, exitCode}`. Nothing was measured. |
| [`authoring-input`](../../spec/schemas/authoring-input.schema.json) | The metadata-only report of `scaffold --from-document` or `--from-fix`. No source text, no claims. |
| [`baseline`](../../spec/schemas/baseline.schema.json) | Frozen fingerprints of existing findings, suppressed up to their count. |
| [`brief`](../../spec/schemas/brief.schema.json) | What to tell an agent before it writes code: ranked, capped, with the next action. |
| [`calibration`](../../spec/schemas/calibration.schema.json) | Per fault class, the observed miss rate with a Wilson interval and the sample size behind it. |
| [`claims`](../../spec/schemas/claims.schema.json) | The claims file, and every scaffold draft. |
| [`common`](../../spec/schemas/common.schema.json) | Shared definitions: verdict, fault class, severity, provenance, source kind, identifier, paths and dates. |
| [`concerns`](../../spec/schemas/concerns.schema.json) | The concerns file: scopes a sweep can be aimed by. |
| [`config`](../../spec/schemas/config.schema.json) | `testguard.config.json`, committed in the project directory. It says how this project's tests run (runner, custom command, interpreter, `node_modules`, type check, workers, confirm, budget), so a plain `testguard probe` needs no flags. See [Configuration](configuration.md#testguardconfigjson-how-this-projects-tests-run). |
| [`evidence`](../../spec/schemas/evidence.schema.json) | One run's records: verdict, every run, defenders, signals, input hashes, rank. |
| [`gate`](../../spec/schemas/gate.schema.json) | Claim coverage of one change. |
| [`ignore`](../../spec/schemas/ignore.schema.json) | The ignore file: reviewable scoping, every entry with a reason. |
| [`replay`](../../spec/schemas/replay.schema.json) | Replayed fix commits and whether the suite would have caught each. |
| [`status`](../../spec/schemas/status.schema.json) | Where the project is and the one next action; also the `--json` output of `probe` and `baseline`. |
| [`sweep`](../../spec/schemas/sweep.schema.json) | What a sweep proposed, probed and found, with its drafts. |

## Next

- [CLI reference](cli.md): the `--out` and `--evidence` flags that move these files.
- [Configuration](configuration.md): the files TestGuard reads, not the ones it writes.
- [Verdicts and signals](verdicts.md): the values inside evidence, replay and sweep documents.
- [Gate semantics](../../spec/GATE-SEMANTICS.md): the normative rules behind the formats.
- [Runner adapter contract](../../spec/RUNNER-ADAPTER.md): what a test-runner adapter must export and guarantee.
