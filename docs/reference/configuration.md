# Configuration reference

The files TestGuard reads from your repository and the environment variables
it honours. This page is for looking up a field or a default; how to write a
good claim is in [writing claims](../guides/writing-claims.md). Every file
here is JSON, validated against a schema in
[`spec/schemas/`](../../spec/schemas/) when it is read, and any defect is
fatal: a claims file is code, so a malformed one stops the run (exit `2`)
rather than being guessed at.

| File | Read by | Commit it |
|---|---|---|
| [`testguard.claims.json`](#claims-file) | every command | yes |
| [`testguard.ignore.json`](#ignore-file) | `gate`, `sweep`, `claims --since` | yes |
| [`testguard.concerns.json`](#concerns-file) | `concerns`, `sweep --concern` | yes, when you have one |

All three live in the project directory, beside each other. Each command has
a flag to point at another path (`--claims`, `--ignore`, `--concerns`).

## Claims file

`testguard.claims.json` declares what must be true and how to try to make it
false. Schema: [`claims.schema.json`](../../spec/schemas/claims.schema.json).
With an npm install, point editors at it for completion and inline errors:

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

With no `defendedBy`, the defenders are discovered: the test files that
import `src/auth.ts`, minus those that mock it.

### Full example

Every optional field in use: a source reference, review provenance, declared
defenders, tags, a fault that targets the second of two identical lines, and a
fault that narrows its own defenders.

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
| `claims` | yes | Array of claims. An empty array is valid; `probe` then exits `2` unless given `--allow-empty`. |

### Claim fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 128 characters. Unique in the file. Renaming it changes every fingerprint derived from it, so a baseline sees the renamed findings as new. |
| `statement` | yes | The claim in plain language, as the project states it (1–2,000 characters). |
| `source.kind` | yes | Declared origin of the intent: `spec`, `adr`, `annotation`, `comment`, `manual`, `doc`, `bug`, `incident`, `review`, `inferred`. A label, not authenticated independence. |
| `source.ref` | no | An opaque reference (up to 512 characters): a document path, an issue number. Never fetched. |
| `severity` | yes | `critical`, `high`, `medium` or `low`. Ranks findings and drives `probe --severity`. |
| `producedBy` | yes | Who produced the claim. See [provenance](#provenance). |
| `defendedBy` | no | Project-relative globs for the test files that defend the claim. Absent or empty means discover them by import. If nothing resolves, the verdict is `nocover`. |
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
| `replace` | yes | Exact replacement text. May be empty; must differ from `find`. |
| `expectHits` | no, default `1` | How many times `find` must occur. Any other count makes the fault `unverifiable` (`anchor-missing` or `anchor-ambiguous`), never a silent skip. |
| `occurrence` | no, default `1` | Which occurrence to replace, 1-based. Must not exceed `expectHits`. |
| `defendedBy` | no | Overrides the claim's defenders for this fault. Absent inherits the claim's; `[]` requests discovery. Changing it invalidates verdict reuse. |
| `producedBy` | yes | Who produced the fault. |
| `method` | no, default `fault-injection` | The shared spec reserves `assertion` and `scan` for tools that verify by reading or scanning. Leave it out. |

`methodDetail` exists in the schema for those reserved methods and is
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
| `pattern` | yes | A glob, a claim ID, or `<claimId>/<faultId>`, depending on `kind` (up to 512 characters). |
| `reason` | yes | At least 8 characters. Not optional: it is what a reviewer reads to accept the exception. |
| `by` | no | Who added it. |
| `at` | no | When, as an ISO 8601 date-time. |
| `expires` | no | After this instant the entry excuses nothing and is reported as `EXPIRED`. |

| `kind` | `pattern` | Used by | Effect |
|---|---|---|---|
| `path` | glob over project paths | `gate`, `sweep` | A changed source file that matches counts as excused. Every reliance is printed. |
| `claim` | claim ID | `claims --since` | Excuses the removal of that claim, and of any of its faults. |
| `fault` | `<claimId>/<faultId>` | `claims --since` | Excuses the removal of that one fault. |
| `fingerprint` | an evidence fingerprint | none | Valid in the schema; TestGuard does not read it. |

An ignore entry never touches a verdict. To accept a known finding, freeze it
in a [baseline](cli.md#baseline) instead.

## Concerns file

`testguard.concerns.json` declares the scopes a [sweep](cli.md#sweep) can be
aimed by. A concern names a *kind* of promise and where to look for it; it is
never a claim and never becomes one. Schema:
[`concerns.schema.json`](../../spec/schemas/concerns.schema.json).
`testguard concerns` lists and validates it.

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
| `statement` | yes | The sentence: a kind of promise ("every write persists the data it was given"), not one behaviour. |
| `severity` | no | `critical`, `high`, `medium` or `low`. |
| `targets.kind` | yes, if `targets` is given | `glob` matches project paths against `targets.globs`; `write-sites` asks the write enumerator for every file that writes to storage; `changed` defers to the diff the sweep is already measuring. Absent `targets` behaves as `changed`. |
| `targets.globs` | with `glob` | Array of globs. |
| `faultClasses` | no | The fault classes worth proposing. `null` or absent means every class. |

Two concerns are built in, and a project file adds to them rather than
replacing them:

| ID | Statement | Targets | Fault classes |
|---|---|---|---|
| `SAVE-PERSISTS` | Every write to storage persists the data it was given. | `write-sites` | `field-dropped`, `call-removed`, `statement-deleted`, `literal-changed` |
| `CHANGED-CODE` | Code changed in this branch is defended by something. | `changed` | every class |

`sweep --save-paths` is sugar for `--concern SAVE-PERSISTS`. There is
deliberately no built-in authorization concern: which files check permissions
cannot be guessed reliably, and a project that knows its own auth layer says
so with a `glob` concern.

## Cost budget file

`testguard.cost-budget.json` in this repository is **not** a TestGuard
configuration file. The CLI never reads it. It is the ceiling for TestGuard's
own self-probe in CI, checked by `.github/scripts/check-cost-budget.mjs`, and
neither the file nor the script ships in the package. To see what your own
probe costs, use `probe --cost` or `claims --cost`; see the
[performance guide](../guides/performance.md).

## Environment variables

### Variables you can set

| Variable | Read by | Meaning |
|---|---|---|
| `TESTGUARD_CHANGED_REF` | `gate`, `sweep`, `status`, `brief`, `probe --json`, the MCP tools | The reference to measure a change against when `--changed` is absent. Checked before the CI variables below. |
| `TESTGUARD_NODE_MODULES` | `probe`, `admit`, `sweep`, `replay` | A `node_modules` directory to link into the scratch worktree. `--node-modules` wins. |
| `TESTGUARD_PYTHON` | `probe`, `claims --check-anchors`, `admit`, `sweep`, `replay` | The Python interpreter for `.py` defenders. `--python` wins where a command accepts it; for `admit`, `sweep` and `replay`, which do not read `--python`, this variable is the way to choose one. |
| `TESTGUARD_GITLAB_TOKEN` | the GitLab CI template only | A project or group access token with `api` scope, used when `post_note: true` to post the brief as a merge-request note. `CI_JOB_TOKEN` cannot write notes. The CLI never reads it. See the [GitLab guide](../guides/ci/gitlab.md). |

### CI variables TestGuard reads

TestGuard does not ask you to set these; your CI platform does. They are how a
change reference is detected without `--changed`, in this order after
`TESTGUARD_CHANGED_REF`:

| Variable | Platform | Used as |
|---|---|---|
| `GITHUB_BASE_REF` | GitHub Actions, pull request events | `origin/<value>` |
| `CI_MERGE_REQUEST_DIFF_BASE_SHA` | GitLab merge request pipelines | the commit itself (needs no fetch) |
| `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | GitLab merge request pipelines | `origin/<value>` (needs `GIT_DEPTH: 0` or a fetch) |
| `VIRTUAL_ENV` | an activated Python virtual environment | the interpreter, after `--python` and `TESTGUARD_PYTHON` |

### Internal variables (do not set)

TestGuard sets these on the child processes it starts. Setting them yourself
changes nothing useful and can break a run.

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
