# Configuration reference

This page covers the files TestGuard reads from your repository and the
environment variables it honors. Use it to look up a field or a default. To
learn how to write a good claim, see [writing claims](../guides/writing-claims.md).
Every file here is JSON. TestGuard validates each file against a schema in
[`spec/schemas/`](../../spec/schemas/) when it reads the file. Any defect is
fatal. A claims file is code, so a malformed one stops the run (exit `2`).
TestGuard does not guess.

| File | Read by | Commit it |
|---|---|---|
| [`testguard.claims.json`](#claims-file) | every command | yes |
| [`testguard.ignore.json`](#ignore-file) | `gate`, `sweep`, `status`/`brief` with a reference, `claims --since` (never `probe`) | yes |
| [`testguard.concerns.json`](#concerns-file) | `concerns`, `sweep --concern` | yes, when you have one |
| [`testguard.config.json`](#testguardconfigjson-how-this-projects-tests-run) | `probe`, `admit`, `sweep`, `replay`, `claims --check-anchors`, `status` | yes, when your tests need runner flags |

All four files live in the project directory, beside each other. Each command
has a flag to point at another path (`--claims`, `--ignore`, `--concerns`).

## Claims file

`testguard.claims.json` declares what must be true. It also declares how to try
to make it false. Schema: [`claims.schema.json`](../../spec/schemas/claims.schema.json).
With an npm install, point editors at the schema for completion and inline
errors:

```json
"$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json"
```

### Minimal example

One claim, one fault. Every field shown is required, except `$schema`.

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": [
    {
      "id": "AUTH-ADMIN",
      "statement": "A caller without the admin role is refused by every admin route.",
      "source": { "kind": "spec" },
      "severity": "critical",
      "producedBy": { "producer": "human" },
      "faults": [
        {
          "id": "F1",
          "description": "The role check never triggers.",
          "faultClass": "condition-forced",
          "file": "src/auth.ts",
          "find": "if (user.role !== 'admin') {",
          "replace": "if (false) {",
          "producedBy": { "producer": "human" }
        }
      ]
    }
  ]
}
```

With no `defendedBy`, TestGuard discovers the defenders: the test files that
import `src/auth.ts`, minus those that mock it.

### Full example

This example uses every optional field. It has a source reference, review
provenance, declared defenders and tags. One fault targets the second of two
identical lines. Another fault narrows its own defenders.

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": [
    {
      "id": "BILLING-REFUND-LIMIT",
      "statement": "A refund larger than the original charge is rejected.",
      "source": { "kind": "bug", "ref": "issue #412" },
      "severity": "high",
      "producedBy": { "producer": "human", "by": "billing team", "reviewedBy": "maintainer", "at": "2026-09-17T00:00:00Z" },
      "defendedBy": ["test/billing/*.test.ts"],
      "tags": ["billing"],
      "faults": [
        {
          "id": "F1",
          "description": "The amount comparison always passes.",
          "faultClass": "return-altered",
          "file": "src/billing/refund.ts",
          "find": "return amount <= charge.amount;",
          "replace": "return true;",
          "producedBy": { "producer": "human" }
        },
        {
          "id": "F2",
          "description": "The second validate() call is dropped.",
          "faultClass": "call-removed",
          "file": "src/billing/refund.ts",
          "find": "validate(refund);",
          "replace": "",
          "occurrence": 2,
          "expectHits": 2,
          "defendedBy": ["test/billing/refund.unit.test.ts"],
          "producedBy": { "producer": "operator", "by": "testguard scaffold" }
        }
      ]
    }
  ]
}
```

### Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `$schema` | no | Editor hint. Ignored by TestGuard. |
| `schemaVersion` | yes | Always `1`. |
| `claims` | yes | Array of claims. An empty array is valid. Then `probe` exits `2` unless you pass `--allow-empty`. |

### Claim fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 128 characters. Unique in the file. A new `id` changes every fingerprint derived from it, so a baseline sees the renamed findings as new. |
| `statement` | yes | The claim in plain language, as the project states it (1–2,000 characters). |
| `source.kind` | yes | Declared origin of the intent: `spec`, `adr`, `annotation`, `comment`, `manual`, `doc`, `bug`, `incident`, `review`, `inferred`. A label, not authenticated independence. |
| `source.ref` | no | An opaque reference (up to 512 characters): a document path, an issue number. Never fetched. |
| `severity` | yes | `critical`, `high`, `medium` or `low`. Ranks findings and drives `probe --severity`. |
| `producedBy` | yes | Who produced the claim. See [provenance](#provenance). |
| `defendedBy` | no | Project-relative globs for the test files that defend the claim. Absent or empty means TestGuard discovers them by import. If nothing resolves, the verdict is `nocover`. |
| `faults` | yes | At least one fault. |
| `tags` | no | Unique identifiers, for your own grouping. |

### Fault fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Identifier, unique within the claim (same pattern as a claim `id`). |
| `description` | yes | What the fault does (1–2,000 characters). |
| `faultClass` | yes | `guard-removed`, `condition-forced`, `statement-deleted`, `variable-swap`, `literal-changed`, `call-removed`, `return-altered`, `exception-swallowed`, `field-dropped`, `argument-swapped`, `element-removed`, `handler-dropped`, `other`. Used for ranking and calibration. |
| `file` | yes | Project-relative path of the source to change. Absolute paths and `..` are rejected. |
| `find` | yes | Exact text to locate in `file` (up to 20,000 characters). |
| `replace` | yes | Exact replacement text. It may be empty. It must differ from `find`. |
| `expectHits` | no, default `1` | How many times `find` must occur. Any other count makes the fault `unverifiable` (`anchor-missing` or `anchor-ambiguous`). TestGuard never skips it silently. |
| `occurrence` | no, default `1` | Which occurrence to replace, 1-based. Must not exceed `expectHits`. |
| `defendedBy` | no | Overrides the claim's defenders for this fault. Absent means the fault inherits the claim's defenders. `[]` requests discovery. Changing it invalidates verdict reuse. |
| `producedBy` | yes | Who produced the fault. |
| `method` | no, default `fault-injection` | The shared spec reserves `assertion` and `scan` for tools that verify by reading or scanning. Leave it out. |

`methodDetail` exists in the schema for those reserved methods. It is
forbidden under `fault-injection`.

### Provenance

| Field | Required | Meaning |
|---|---|---|
| `producer` | yes | `human` (authored by a person), `agent` (proposed by an LLM agent), `operator` (emitted by a mechanical mutation operator), `derived` (computed from another artifact). |
| `by` | no | Who or what, free text. |
| `reviewedBy` | no | Who reviewed it. |
| `at` | no | ISO 8601 date-time with a zone, e.g. `2026-09-17T00:00:00Z`. |

The validator also rejects duplicate claim IDs, duplicate fault IDs within a
claim, an `occurrence` above `expectHits`, and a `replace` identical to `find`.

## Ignore file

`testguard.ignore.json` is reviewable scoping: every entry says what it
excuses and why. Schema: [`ignore.schema.json`](../../spec/schemas/ignore.schema.json).
TestGuard reads only this structured JSON form.

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/ignore.schema.json",
  "schemaVersion": 1,
  "entries": [
    {
      "kind": "path",
      "pattern": "src/cli/**",
      "reason": "Thin wrappers: read flags, call the module, print. The logic is claimed in the modules they call.",
      "by": "maintainer",
      "at": "2026-09-17T00:00:00Z"
    },
    {
      "kind": "path",
      "pattern": "src/legacy/billing.ts",
      "reason": "Scheduled for deletion; claims would outlive the file.",
      "by": "maintainer",
      "at": "2026-09-17T00:00:00Z",
      "expires": "2026-12-31T00:00:00Z"
    },
    {
      "kind": "claim",
      "pattern": "ORDERS-LEGACY-EXPORT",
      "reason": "Export endpoint removed with the v2 API; the claim went with it.",
      "by": "maintainer",
      "at": "2026-09-17T00:00:00Z"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | What `pattern` names. See the table below. |
| `pattern` | yes | A glob, a claim ID, or `<claimId>/<faultId>`, depending on `kind` (up to 512 characters). TestGuard matches a `claim` or `fault` pattern exactly, so it refuses anything but an exact identity as invalid. |
| `reason` | yes | At least 8 characters. It is not optional: a reviewer reads it to accept the exception. |
| `by` | no | Who added it. |
| `at` | no | When, as an ISO 8601 date-time. |
| `expires` | no | After this instant the entry excuses nothing and is reported as `EXPIRED`. |

| `kind` | `pattern` | Used by | Effect |
|---|---|---|---|
| `path` | glob over project paths | `gate`, `sweep`, `status --changed`, `brief` | A changed source file that matches counts as excused from the change gate. TestGuard prints every reliance. |
| `claim` | one claim ID, exactly | `claims --since` | Excuses the removal of that claim, and of any of its faults. |
| `fault` | `<claimId>/<faultId>`, exactly | `claims --since` | Excuses the removal of that one fault. |

These three are the only kinds. An entry of any other kind makes the file
invalid. That includes `fingerprint`, which earlier versions of the schema
accepted but nothing read. Every command that reads the file then exits `2` and
names the kinds that exist.

An ignore entry never touches a verdict, and `probe` never reads the ignore
file. `probe` always probes a claim in the claims file, so no entry can hide a
survivor. To accept a known finding, freeze it in a
[baseline](cli.md#baseline) instead. A baseline is fingerprinted and counted,
and TestGuard still reports every finding it covers as baselined.

## Concerns file

`testguard.concerns.json` declares the scopes that can aim a [sweep](cli.md#sweep).
A concern names a *kind* of promise and where to look for it. It is never a
claim and never becomes one. Schema:
[`concerns.schema.json`](../../spec/schemas/concerns.schema.json).
`testguard concerns` lists and validates the file. If the file is not valid
JSON or does not conform, `concerns` and `sweep` exit `2` and name the file and
the error. TestGuard never reads such a file as "no concerns".

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/concerns.schema.json",
  "schemaVersion": 1,
  "concerns": [
    {
      "id": "ADMIN-GUARDS",
      "statement": "Every admin route refuses a caller without the admin role.",
      "severity": "critical",
      "targets": { "kind": "glob", "globs": ["src/app/api/admin/**"] },
      "faultClasses": ["guard-removed", "condition-forced", "return-altered"]
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Identifier, unique in the file. An `id` equal to a built-in replaces it, and `concerns` reports the replacement. |
| `statement` | yes | The sentence: a kind of promise ("every write persists the data it was given"), not one behavior. |
| `severity` | no | `critical`, `high`, `medium` or `low`. |
| `targets.kind` | yes, if `targets` is given | `glob` matches project paths against `targets.globs`. `write-sites` asks the write enumerator for every file that writes to storage. `changed` uses the diff the sweep is already measuring. Absent `targets` behaves as `changed`. |
| `targets.globs` | with `glob` | Array of globs. |
| `faultClasses` | no | The fault classes worth proposing. `null` or absent means every class. |

Two concerns are built in. A project file adds to them and does not replace
them:

| ID | Statement | Targets | Fault classes |
|---|---|---|---|
| `SAVE-PERSISTS` | Every write to storage persists the data it was given. | `write-sites` | `field-dropped`, `call-removed`, `statement-deleted`, `literal-changed` |
| `CHANGED-CODE` | Code changed in this branch is defended by something. | `changed` | every class |

`sweep --save-paths` is a shorthand for `--concern SAVE-PERSISTS`. There is
deliberately no built-in authorization concern. TestGuard cannot reliably guess
which files check permissions. A project that knows its own auth layer says so
with a `glob` concern.

## testguard.config.json: how this project's tests run

Some projects need runner flags: `--runner unittest --python
.venv/bin/python`, a `--runner-cmd`, or a `--node-modules` from the workspace
root. Without a config file, you must repeat them in every hook, every CI line
and every agent's memory. Put them in `testguard.config.json` instead. Then a
plain `testguard probe` runs the tests correctly everywhere. Schema:
[`config.schema.json`](../../spec/schemas/config.schema.json).

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/config.schema.json",
  "schemaVersion": 1,
  "runner": "unittest",
  "python": ".venv/bin/python",
  "confirm": 3
}
```

| Key | Flag it stands for | Value |
|---|---|---|
| `runner` | `--runner` | `vitest`, `jest`, `playwright`, `python`, `pytest`, `unittest`, `node-test` or `auto` |
| `runnerCmd` | `--runner-cmd` | a command containing `{files}` and `{out}`, run as an argv, never through a shell. A reporter file path in it (`--test-reporter=./tools/reporter.mjs`) must start with `./` or be absolute, because Node reads a bare value as a package name |
| `reportFormat` | `--report-format` | `jest` (the default) or `junit`: how the report of a `runnerCmd` is read. It needs a command, from this file or from `--runner-cmd` |
| `testGlobs` | `--test-glob` | a non-empty list of distinct globs, relative to the project directory and written with `/` (`"src/test/**/*Test.java"`). They name the tests of a `runnerCmd` suite that no built-in glob lists, so escalation can ask them. The list needs a custom command, from `runnerCmd` or `--runner-cmd`. A `--test-glob` you type replaces the whole list |
| `python` | `--python` | a bare command looked up on `PATH` (`python3`), or a path relative to the project directory |
| `nodeModules` | `--node-modules` | a directory relative to the project directory (`../node_modules` in a workspace package) |
| `typecheck` | `--typecheck` | `true` runs the project's own `tsc`. A string is the command. Applies to `probe` and `claims --check-anchors` |
| `workers` | `--workers` | a positive integer |
| `faultWorkers` | `--fault-workers` (`probe`) | a positive integer, or `"auto"` |
| `confirm` | `--confirm` | a positive integer. Below 3 the run is provisional, exactly as with the flag, and the warning names this file |
| `budget` | `--budget` | milliseconds per run, at least 1000 |

Only options that describe **how** the tests run belong here. Nothing in the
file selects **what** TestGuard probes (`--claim`, `--changed`, `--ref`).
Nothing in it shapes output. No value can do what its flag could not.

- **Precedence:** TestGuard uses the first of these that is set. First, a
  flag you type. Second, the environment variable where one exists
  (`TESTGUARD_PYTHON`, `TESTGUARD_NODE_MODULES`, `TESTGUARD_FAULT_WORKERS`;
  empty is unset). Third, the file. Fourth, the built-in default.
  `--no-config` ignores the file. It is also the way to turn off a `typecheck`
  or `runnerCmd` that the file sets, which have no "off" flag.
- **Refused, never ignored:** these are usage errors (exit `3`) that name the
  key: malformed JSON, an unknown key, a wrong type, or an unusable `runnerCmd`.
  A misspelled `confirmRuns` would otherwise fall back to the default silently.
  TestGuard also refuses a path that leaves the repository, and an absolute
  path (`path-outside-project`, exit `2`). A committed setting must work on
  every checkout. So put a machine-specific path in the flag or the variable.
  TestGuard judges paths by their text, so a virtualenv's `python` that links
  out of the tree is fine.
- **Which copy is read:** the one in the working tree, like the flags you type
  with the command. TestGuard then treats an uncommitted or untracked
  `testguard.config.json` like a dirty defender. `probe` of the implicit
  `HEAD` refuses (exit `2`) rather than measure a commit with options nobody
  committed. `--include-dirty` and `--in-place` probe the working tree the file
  belongs to. `--ref` and `--ignore-dirty` proceed and say that they apply the
  working-tree copy. `replay` has no dirty rule, and it says so too.
- **Reuse:** the options the file resolves to decide whether TestGuard may
  carry a verdict forward, never the file's bytes. If you move a flag into the
  file with the same value, every verdict stays. If you change a value
  (`runner`, `runnerCmd`, `python`, `typecheck`, `workers`, `confirm`),
  TestGuard re-measures, exactly as when you change the flag.
- **`--changed`:** the file is an input of every claim, like a lockfile. So a
  change to it selects every claim (`probe --changed <ref> --explain` names it
  as the reason). Reuse then carries forward whatever the change did not touch.
- **Reported:** `status` prints the keys the file sets, and `status --json`
  carries `config: {file, sha256, keys}`. `probe --json` carries `run.config`
  with the keys this run took from the file and the ones a flag or variable
  overrode.

## Cost budget file

`testguard.cost-budget.json` in this repository is **not** a TestGuard
configuration file. The CLI never reads it. It is the ceiling for TestGuard's
own self-probe in CI. `.github/scripts/check-cost-budget.mjs` checks it.
Neither the file nor the script ships in the package. To see what your own
probe costs, use `probe --cost` or `claims --cost`. See the
[performance guide](../guides/performance.md).

The total ceiling (`seconds`) applies to the self-probe's **normalized elapsed
time** at one fault-worker count (`unit: "normalized-elapsed-seconds"`,
`faultWorkers`), since #284. The probe probes several faults at once by
default. When two faults run at once, summed defender seconds rise while the
job gets faster (4243 summed against 1807 elapsed on one run). So TestGuard
prints the sum beside the decision and never gates on it. A run at another
fault-worker count fails closed (`fault-workers-mismatch`), as does a run on
another runner class. Evidence with no `run.measurements.elapsedMs` also fails
closed (`elapsed-missing`). The per-claim ceiling (`perClaimSeconds`) is still
on summed seconds, which overlap inflates. #284 tracks its unit.

The ceilings are in **normalized seconds**. A CI runner's speed moved the same
592 faults between 2876 s and 4159 s. So the check divides by a speed factor
measured in the same job. For the total ceiling, the factor uses the elapsed
time. For the per-claim ceiling, it uses the summed run durations. The job
times a fixed workload immediately before and after the self-probe. The
workload is `.github/scripts/measure-reference.mjs`: it starts `node --test` on
a tiny project nine times and takes the median. The factor is the mean of those
two medians over the `reference.baselineMs` recorded in the file. Every time,
the check prints the raw seconds, both medians, the factor and the normalized
seconds.

Sometimes the two medians differ by more than `reference.maxDrift`, because the
runner's speed moved during the probe. Then the factor is the **faster** median
over the baseline. This is the pessimistic reading. A mean would credit a
runner that slowed down mid-run for speed it did not have throughout (170 ms
then 320 ms turned 4588 normalized seconds into 3184). The output says which
reading it used.

The reference tracks probe speed within one class of machine, not across
classes. An 18-core laptop read 177 ms, inside the CI range of 166 to 238 ms,
and runs the probe far faster than CI. So `reference.cpus` and
`reference.platform` record the runner class where TestGuard took the baseline.
Each measurement records the CPU count and platform it ran on. A measurement
from another class (or one that does not say) fails the check with
`reference-runner-mismatch`, naming both. To take a baseline on another class,
set a new `baselineMs`, `cpus`, `platform` and ceiling together.

The check fails closed. It fails and says which cause applies when it finds any
of these: a missing measurement, a measurement of a different workload or
runner class, or a factor outside `reference.factorRange`. It never falls back
to raw seconds. A run is low confidence if the two medians differ by more than
`reference.maxDrift`, or if the probe reused verdicts recorded on other
runners. A low-confidence run can still pass. But a low-confidence run over a
ceiling fails, and no correction excuses it, because TestGuard cannot trust the
correction. To change the workload, change its name in the script and take the
baseline again in the same pull request.

## Where TestGuard writes

This is the whole list for a confined run: no network, a read-only root, one
writable workspace, one temp directory, and `node_modules` installed
beforehand.

| Path | Written by | Why |
|---|---|---|
| the scratch directory (`--scratch-dir`, `TESTGUARD_SCRATCH_DIR`, else the OS temp directory) | `probe`, `sweep`, `replay`, `admit` | scratch worktrees, the temporary git index, runner report and sidecar reporter files, and one private temp and data directory per runner process. Each is removed when its run ends. Also `testguard-locks/`, the worktree-allocation lock directory (kept, empty between runs) |
| the evidence path (`--out`, else `<dir>/.testguard/`; `replay` also writes its calibration beside its report) | every command that writes evidence | the result of the run |
| the repository's `.git` | `probe`, `sweep`, `replay`, `admit` | `worktrees/` metadata for each scratch worktree (removed with it), and loose objects when `--include-dirty` snapshots an unstaged tree |
| the working tree and `.testguard/` | `scaffold --into`, `claims --annotate --apply`, `init`, `baseline`, `--in-place` | commands whose job is to write the project. `probe --in-place` edits the fault target and restores it |

`--scratch-dir` must name a directory that exists and can be written. If it
does not, the command exits 2 before it writes anything. TestGuard never
creates the directory for you. Every other path is read-only to TestGuard.

**The linked `node_modules` is never written through.** The scratch worktree
gets a `node_modules` directory of its own. Its entries link to the shared
install. So when a tool writes `node_modules/.vite-temp`, `.vite`, `.vitest` or
`.cache`, it writes into the scratch tree. Some tool caches live in the temp
directory: jest's haste map and transform cache, and Playwright's transform
cache. They follow the runner's `TMPDIR`, which TestGuard points into the
scratch directory. Python writes no bytecode (`PYTHONDONTWRITEBYTECODE`,
`PYTHONPYCACHEPREFIX`), and pytest runs with `-p no:cacheprovider`. The
dirty-tree test discovery runs in your own tree, whose `node_modules` cannot be
swapped. Against a read-only install, it asks vitest 4 and later for
`--configLoader runner`. The evidence records `run.writeBoundary`. It is a
signal for whether the install was writable, never a path.

**What this does not promise.** Tests under probe run the project's own code,
with your privileges. They are not sandboxed. The write boundary lists where
TestGuard and its built-in runners write. It does not stop a test from writing
elsewhere, reading your files or opening a socket. It also does not close some
known leaks. For example, vitest keeps an API token in the per-user data
directory. Only Linux redirects that directory (`XDG_DATA_HOME`). macOS and
Windows write the token under the home directory. `--in-place` writes the
working tree by definition. Use a container or VM for untrusted code, and give
it a writable scratch directory.

## Environment variables

### Variables you can set

| Variable | Read by | Meaning |
|---|---|---|
| `TESTGUARD_CHANGED_REF` | `gate`, `sweep`, `status`, `brief`, the MCP tools | The reference to measure a change against when `--changed` is absent. TestGuard checks it before the CI variables below. |
| `TESTGUARD_WORKER` | set by `probe` | TestGuard sets it and does not read it. Every test runner process a probe starts gets the 0-based index of the scratch tree it runs in. Trees running side by side have different indices. A run with nothing else in flight is `0`. Derive a port, a database name or a directory from it (`8787 + TESTGUARD_WORKER`), and a suite that needs one of its own stays parallel. |
| `TESTGUARD_FAULT_WORKERS` | `probe` | How many faults to probe at once: a positive integer or `auto` (the default: `min(4, floor(CPUs / 2))`). `--fault-workers` and `--serial` win over it. It wins over `faultWorkers` in `testguard.config.json`. Empty is unset. `1` restores one fault at a time. |
| `TESTGUARD_NODE_MODULES` | `probe`, `admit`, `sweep`, `replay` | A `node_modules` directory to link into the scratch worktree. `--node-modules` wins over it. It wins over `nodeModules` in `testguard.config.json`. |
| `TESTGUARD_SCRATCH_DIR` | `probe`, `admit`, `sweep`, `replay` | An existing, writable directory for everything TestGuard creates while it runs tests: scratch worktrees, the temporary git index, runner reports and runner temp directories. `--scratch-dir` wins over it. A missing or unwritable directory is an error (exit 2) before anything is written. Default: the OS temp directory. |
| `TESTGUARD_PYTHON` | `probe`, `claims --check-anchors`, `admit`, `sweep`, `replay` | The Python interpreter for `.py` defenders. `--python` wins over it when both are given, and it wins over `python` in `testguard.config.json`. The two mean the same thing: TestGuard looks up a bare name such as `python3` on `PATH`, and treats anything containing `/` as a path. |
| `TESTGUARD_GITLAB_TOKEN` | the GitLab CI template only | A project or group access token with `api` scope. The template uses it when `post_note: true` to post the brief as a merge-request note. `CI_JOB_TOKEN` cannot write notes. The CLI never reads it. See the [GitLab guide](../guides/ci/gitlab.md). |

### CI variables TestGuard reads

TestGuard does not ask you to set these. Your CI platform sets them. They let
TestGuard detect a change reference without `--changed`, in this order after
`TESTGUARD_CHANGED_REF`:

| Variable | Platform | Used as |
|---|---|---|
| `GITHUB_BASE_REF` | GitHub Actions, pull request events | `origin/<value>` |
| `CI_MERGE_REQUEST_DIFF_BASE_SHA` | GitLab merge request pipelines | the commit itself (needs no fetch) |
| `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | GitLab merge request pipelines | `origin/<value>` (needs `GIT_DEPTH: 0` or a fetch) |
| `VIRTUAL_ENV` | an activated Python virtual environment | the interpreter, after `--python` and `TESTGUARD_PYTHON` |

### Internal variables (do not set)

TestGuard sets these on the child processes it starts. If you set them
yourself, nothing useful happens, and you can break a run.

| Variable | Set for |
|---|---|
| `TESTGUARD_REPORT`, `TESTGUARD_TARGETS` | the bundled Python reporter |
| `TESTGUARD_NODE_ENTRIES`, `TESTGUARD_NODE_COLLECT`, `TESTGUARD_NODE_WORKERS`, `TESTGUARD_NODE_REPORT`, `TESTGUARD_NODE_DIRECT` | the `node-test` runner adapter |
| `TESTGUARD_VERSION`, `TESTGUARD_DIR` | the GitLab CI template's jobs, from its `version` and `dir` inputs |

## Next

- [Writing claims](../guides/writing-claims.md): how to choose a claim, its faults and its defenders.
- [CLI reference](cli.md): the flags that point at these files.
- [Artifacts](artifacts.md): what TestGuard writes back, and which files to commit.
- [Verdicts and signals](verdicts.md): what a probe concludes from the claims file.
