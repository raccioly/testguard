# Writing claims

This guide is for whoever authors `testguard.claims.json`: a developer, a
reviewer, or an agent working under review. It covers what makes a claim worth
writing, every field of a claim and a fault, how defenders are chosen, three
complete worked examples, the tools that propose faults for you, and how to
remove a claim without it looking like a cover-up. The model behind it is in
[How TestGuard works](../concepts/how-it-works.md).

## What makes a good claim

A claim is an **observable promise**: something a caller, a user or an
auditor could see go wrong. Write it the way the project would state it to a
reviewer, not the way the code implements it.

| Weak | Better | Why |
|---|---|---|
| "`requireAdmin` checks roles." | "A caller without the admin role is refused." | Names the outcome, not the mechanism. A refactor keeps the promise. |
| "The audit function works." | "Every audit row records the id of the actor who performed the action." | Falsifiable: one dropped field makes it false. |
| "Rate limiting is correct." | "A client that has made `limit` requests in the last 60 seconds is refused the next one." | Says which input, which outcome, which forbidden outcome. |

### Intent comes first, and from outside the code

A test written by reading the code encodes whatever the code does, bugs
included. So the intended behaviour has to come from somewhere the
implementation did not: a requirement, an ADR, a bug report, an incident.
Before you adopt any draft, write down:

- the **inputs** (who calls, with what);
- the **expected outcome**;
- the **forbidden outcome**, which is what each fault will try to produce.

Record where it came from in `source.kind` and `source.ref`. When no such
source exists, keep `source.kind: "inferred"` and say so: an inferred claim is
still useful, but it is not independent intent. TestGuard never fetches or
authenticates a reference, and a passing test does not establish intent.
Paraphrasing the code into a sentence is not independent intent either.

`scaffold` drafts always declare `inferred`, even when grouped under an
annotation; supplying the source is your job. When you scaffold under an
existing claim with `--claim`, that claim's statement and source are kept.

### Keep claims small

One promise per claim, and the fewest faults that would make it false. A claim
that bundles three promises gives a verdict nobody can act on, and costs more
to probe: each fault runs its defenders N times. Two or three precise faults
beat ten loose ones.

## Anatomy of a claim

Claims live in `testguard.claims.json` beside your project's `package.json` or
`pyproject.toml`. Point editors at the schema for completion and validation:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": []
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Stable identifier: letters, digits, `.`, `_`, `-`, starting with a letter or digit, up to 128 characters. Use a hyphen (`AUTH-ADMIN-001`) so a source annotation can name it. Renaming changes every fingerprint derived from it. |
| `statement` | yes | The promise in plain language, up to 2,000 characters. |
| `source` | yes | `{ "kind": …, "ref": … }`: where the intent came from. `ref` is optional and opaque (up to 512 characters). |
| `severity` | yes | `critical`, `high`, `medium` or `low`. Drives ranking and the `--severity` gate floor. |
| `producedBy` | yes | `{ "producer": "human" \| "agent" \| "operator" \| "derived", "by", "reviewedBy", "at" }`. Only `producer` is required. |
| `defendedBy` | no | Globs for the test files that defend the claim. Absent or empty means discover them. |
| `faults` | yes | At least one fault. |
| `tags` | no | Unique identifiers for your own grouping. |

`claims` rejects duplicate claim ids and duplicate fault ids within a claim.
The tables on this page are for authoring; the complete file format is in
[configuration](../reference/configuration.md#claims-file).

### Source kinds

| `source.kind` | Use it when the intent came from |
|---|---|
| `spec` | a requirement or specification |
| `adr` | an architecture decision record |
| `bug` | a bug report |
| `incident` | a production incident |
| `review` | a code or security review finding |
| `doc` | product or user documentation |
| `manual` | a person stating it directly, with no document behind it |
| `annotation` | a `@claim` annotation in source (see [below](#linking-claims-from-source)) |
| `comment` | a code comment |
| `inferred` | nobody supplied it; it was read off the code |

These are declared labels, not authenticated independence, and not a strength
order. Ranking weights `spec` and `adr` highest and `annotation` and `comment`
lowest, but a label never waives a finding. `producedBy.producer` is separate:
it records who *wrote the entry*, while `source` records where the *intent*
came from.

## Faults

A fault is one concrete way the claim could be false, written as an exact
substitution.

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Unique within the claim (`F1`, `F2`…). |
| `description` | yes | What the fault does, in words a reviewer can check against the claim. |
| `faultClass` | yes | The shape of the break; see below. |
| `file` | yes | Project-relative path of the file to change. No absolute paths, no `..`. |
| `find` | yes | Exact text to locate. Whitespace and `\n` count. |
| `replace` | yes | Exact replacement. May be empty (deletes `find`). Must differ from `find`. |
| `expectHits` | no, default `1` | How many times `find` must occur in `file`. Any other count is `UNVERIFIABLE`, never a skip. |
| `occurrence` | no, default `1` | Which occurrence to replace, 1-based. Must not exceed `expectHits`. |
| `defendedBy` | no | Overrides the claim's defenders for this fault; see [Defenders](#defenders). |
| `producedBy` | yes | Same shape as the claim's. |

Leave `method` out. It defaults to `fault-injection`, the only method claimspec
v1 fully specifies; `assertion` and `scan` are reserved for other Guard tools.

**Fault classes:** `guard-removed`, `condition-forced`, `statement-deleted`,
`variable-swap`, `literal-changed`, `call-removed`, `return-altered`,
`exception-swallowed`, `field-dropped`, `argument-swapped`, `element-removed`,
`handler-dropped`, `other`. The class does not change how the fault is
applied; it is the join key [replay](replay.md) uses to calibrate how often
bugs of that shape escape.

### What makes a good fault

- **It makes the statement false, and nothing else.** If the claim is "the
  actor is recorded", drop the actor field; do not also break the timestamp.
- **It compiles.** A replacement that does not load is `FAULT-INVALID`: a run
  spent saying nothing about the tests.
- **It is observable.** If no input could reveal the change, the fault is an
  equivalent mutant and will survive forever. Rewrite it.
- **Its anchor is unique.** Prefer a full line or a distinctive fragment. When
  the same text legitimately occurs twice, set `expectHits` to the real count
  and `occurrence` to the one you mean.

### Anchors rot; check them cheaply

An anchor is exact text, so editing the guarded line breaks it. Find out
before a probe does:

```bash
npx testguard-cli claims --check-anchors   # locate every anchor; syntax-check replacements
```

It locates every anchor, and parses each replacement in memory for `.js`,
`.mjs`, `.cjs` and Python files (other files are located but not parsed). It
runs no tests, creates no worktree and changes no file, and exits `1` when an
anchor is missing or ambiguous or a checked replacement does not compile:

```text
OK               AUTH-ADMIN-001/F1  src/auth.mjs — 1 hit, expected 1; javascript syntax ok
OK               AUDIT-ACTOR-001/F1  src/audit.mjs — 1 hit, expected 1; javascript syntax ok
anchor preflight: 4 faults checked, 4 ok, 0 invalid in 23ms
```

It reports and stops; it never guesses a new anchor. Repair the fault so it
still means the same thing, then re-probe. `status` reports
`invalid-anchors` before any evidence state for the same reason.

## Defenders

Defenders are chosen at three levels, most specific first:

| Where | Meaning |
|---|---|
| fault `defendedBy: ["…"]` | this fault uses these files, whatever the claim says |
| fault `defendedBy: []` | this fault requests **discovery**, even if the claim names defenders |
| claim `defendedBy: ["…"]` | every fault without its own `defendedBy` inherits these |
| absent everywhere (or a claim-level `[]`) | discovery |

A typical split: a unit-level fault selects `["test/unit/rate.test.mjs"]` while
an integration fault inherits the claim's broader set. `claims` prints the
selection per fault (`RATE-WINDOW-001/F2: fault (discovery) — …`), and the
evidence records where each selection came from. Changing a selection
invalidates verdict reuse; narrowing a fault's set after it was killed is
warned about. Re-probe and read the verdict rather than assume.

### Discovery, and why mocks do not count

Discovery picks the test files that import the fault's target: by relative
path, `tsconfig` `paths` (through `extends` and `references`), vite/vitest
`resolve.alias` and `package.json` `imports`, following the imported symbol
through barrel files. Then it removes every file that **mocks** the target:
a test that `vi.mock`s or `jest.mock`s a module cannot detect a fault inside
it. `NOCOVER` therefore means exactly "no test file imports this source
without mocking it". `claims` prints the split (for example `18 import · 16
mock · 2 can detect`).

A mocking file that never asserts on anything it imported from the target
carries the signal `mocked-never-asserted`, the cheapest blind-spot signal
there is. If the mock is deliberate, say why with a comment on or above it:

```js
// unasserted: the mailer is mocked only to stop network calls; delivery is claimed in mailer.test.mjs
vi.mock('../src/mailer.mjs');
```

The signal is then recorded as `unasserted-annotated` with your reason:
silenced, never hidden. Python's `patch("pkg.mod.fn")` replaces one attribute,
not the module, so that file stays a defender; see the
[Python guide](python.md). All signals are listed in
[verdicts](../reference/verdicts.md).

## Worked examples

Three small claims from three neutral domains, each validated with
`claims` and `claims --check-anchors` and probed with Node's built-in runner.
Together they make one valid claims file: put the three objects in one
`claims` array.

### 1. An authorization guard (killed)

`src/auth.mjs`:

```js
export function requireAdmin(user) {
  if (!user || !user.roles.includes('admin')) {
    throw new Error('forbidden');
  }
  return user;
}
```

The claim, from a written requirement:

```json
{
  "id": "AUTH-ADMIN-001",
  "statement": "A caller without the admin role is refused; requireAdmin never returns for them.",
  "source": { "kind": "spec", "ref": "docs/requirements.md#admin-access" },
  "severity": "critical",
  "producedBy": { "producer": "human", "by": "maintainer", "at": "2026-10-01T00:00:00Z" },
  "defendedBy": ["test/auth.test.mjs"],
  "faults": [
    {
      "id": "F1",
      "description": "The role check never triggers, so every caller is treated as an admin.",
      "faultClass": "condition-forced",
      "file": "src/auth.mjs",
      "find": "if (!user || !user.roles.includes('admin')) {",
      "replace": "if (false) {",
      "producedBy": { "producer": "human", "by": "maintainer" }
    }
  ]
}
```

`test/auth.test.mjs` asserts that a `viewer` is refused with
`assert.throws(…, /forbidden/)`. With the fault applied that assertion fails in
all three runs, so the fault is `killed`.

### 2. An audit-log field (SURVIVED, then fixed)

`src/audit.mjs`:

```js
export function auditRow(actor, action, target, now = new Date()) {
  return {
    actor: actor.id,
    action,
    target,
    at: now.toISOString(),
  };
}
```

The claim came from an incident, where rows without an actor could not be
traced. The fault deletes one whole line, so `find` includes the indentation
and the newline:

```json
{
  "id": "AUDIT-ACTOR-001",
  "statement": "Every audit row records the id of the actor who performed the action.",
  "source": { "kind": "incident", "ref": "INC-2041" },
  "severity": "high",
  "producedBy": { "producer": "human", "by": "maintainer", "at": "2026-10-01T00:00:00Z" },
  "defendedBy": ["test/audit.test.mjs"],
  "faults": [
    {
      "id": "F1",
      "description": "The actor field is dropped from the audit row.",
      "faultClass": "field-dropped",
      "file": "src/audit.mjs",
      "find": "    actor: actor.id,\n",
      "replace": "",
      "producedBy": { "producer": "human", "by": "maintainer" }
    }
  ]
}
```

The existing test checks `row.action` and `row.target` and never names
`actor`, so the suite stays green with the field gone:

```text
SURVIVED        AUDIT-ACTOR-001/F1     high     src/audit.mjs  The actor field is dropped from the audit row.
```

The fix is a test that names the field, here by asserting the whole row:

```js
test('an audit row records who acted', () => {
  const row = auditRow({ id: 'u1' }, 'refund', 'order-7', new Date(0));
  assert.deepEqual(row, { actor: 'u1', action: 'refund', target: 'order-7', at: '1970-01-01T00:00:00.000Z' });
});
```

```bash
npx testguard-cli admit test/audit.test.mjs --claim AUDIT-ACTOR-001 --runner node-test
```

```text
  killed          AUDIT-ACTOR-001/F1  The actor field is dropped from the audit row.

ADMITTED — test/audit.test.mjs passes on HEAD and fails on the fault of AUDIT-ACTOR-001, 3/3. Commit it.
```

This is the same blind spot as `expect.objectContaining({…})` omitting a key:
a partial assertion cannot fail on a field it does not list.

### 3. A rate-limit window (two faults, mixed defender selection)

`src/ratelimit.mjs`:

```js
const WINDOW_MS = 60_000;

export function allow(hits, now, limit = 5) {
  const recent = hits.filter((t) => now - t < WINDOW_MS);
  return recent.length < limit;
}
```

Two different ways the promise can break, each its own fault. `F1` inherits
the claim's defender; `F2` sets `defendedBy: []` to request discovery:

```json
{
  "id": "RATE-WINDOW-001",
  "statement": "A client that has made `limit` requests in the last 60 seconds is refused the next one.",
  "source": { "kind": "adr", "ref": "docs/adr/0007-rate-limits.md" },
  "severity": "medium",
  "producedBy": { "producer": "human", "by": "maintainer", "at": "2026-10-01T00:00:00Z" },
  "defendedBy": ["test/ratelimit.test.mjs"],
  "faults": [
    {
      "id": "F1",
      "description": "The window shrinks from 60 seconds to 60 milliseconds, so almost nothing counts.",
      "faultClass": "literal-changed",
      "file": "src/ratelimit.mjs",
      "find": "const WINDOW_MS = 60_000;",
      "replace": "const WINDOW_MS = 60;",
      "producedBy": { "producer": "human", "by": "maintainer" }
    },
    {
      "id": "F2",
      "description": "The limit is never applied; every request is allowed.",
      "faultClass": "return-altered",
      "file": "src/ratelimit.mjs",
      "find": "return recent.length < limit;",
      "replace": "return true;",
      "defendedBy": [],
      "producedBy": { "producer": "human", "by": "maintainer" }
    }
  ]
}
```

`claims` shows the selection each fault ended up with:

```text
  RATE-WINDOW-001/F1: claim — test/ratelimit.test.mjs
  RATE-WINDOW-001/F2: fault (discovery) — test/ratelimit.test.mjs
```

A test that sends five requests one to five seconds ago and expects the sixth
to be refused kills both faults. Note what `scaffold` proposed for this file
on its own: one `literal-changed` fault on `limit = 5`, and nothing for the
window or the comparison. Mechanical proposals are a starting point; the
faults that express the promise are yours to write.

## Check your work

```bash
npx testguard-cli claims                       # validate the file; report annotation drift
npx testguard-cli claims --check-anchors       # every anchor located, replacements parsed
npx testguard-cli probe --claim AUTH-ADMIN-001 # probe one claim (repeat or comma-separate for more)
npx testguard-cli admit test/auth.test.mjs --claim AUTH-ADMIN-001   # judge one test against one claim
```

`probe --claim` writes `.testguard/evidence-partial.json`, so a subset never
masquerades as the full run. While iterating, `--no-escalate` and
`--confirm 1` make a fast provisional pass; finish with the defaults.

## admit: the two-gate rule

A test is admitted only when it passes **both** gates: green on unmodified
`HEAD`, and red on every fault of the claim, N out of N.

```bash
npx testguard-cli admit test/auth.test.mjs --claim AUTH-ADMIN-001
npx testguard-cli admit test/auth.test.mjs --claim AUTH-ADMIN-001 --fault F1 --confirm 1   # fast, provisional
```

- `ADMITTED` (exit `0`): every fault is killed N/N by defenders that are green
  N/N.
- `NOT ADMITTED` (exit `1`): names the first blocking fault and what to do.
- Exit `3`: the test file is not a declared or discovered defender of the claim.
  Add it to `defendedBy` first.

`admit` is `probe --claim <ID> --include-dirty` under another name, so it judges
your uncommitted test without touching the tree and can never disagree with
the gate. Its evidence goes to `.testguard/evidence-partial.json`. A
`--confirm 1` result prints `ADMITTED?` and must be confirmed at 3 before you
commit. Generators admit a test because it compiles, passes and raises
coverage; `admit` admits it because it fails when the claim is false.

## Linking claims from source

A `@claim <ID>` comment in a source file links that file to a claim. `claims`
reconciles both directions:

- an annotation whose id is not in the claims file is reported as
  `UNDECLARED` (a claim with no fault model) and exits `1`;
- a claim with `source.kind: "annotation"` that no source file carries is
  reported as `STALE` and also exits `1`.

Two rules keep the scan honest. **Test files are not scanned**: a claim
asserted by a test is the authorship trap the tool exists for. And **an
annotation id must contain a hyphen**, so prose such as "@claim annotations"
is never mistaken for one. Hidden directories, `node_modules`, `dist`,
`coverage` and nested projects with their own claims file are skipped too.

Other declared claims with no source link produce an `ANNOTATION ADVISORY`
note. It is advice only: it never changes verification state, the next action
or an exit code, and exact fault anchors are checked either way. A link is
lexical, not authenticated intent or ownership. `status` computes the same
advice with a bounded scan (10,000 entries, 1,000 files, 64 directory levels,
256 KiB per file, 2 MiB total) and reports it as unavailable rather than
concluding an id is absent when the bound is reached.

### Placing annotations: `claims --annotate`

```bash
npx testguard-cli claims --annotate --claim AUTH-ADMIN-001            # read-only preview
npx testguard-cli claims --annotate --claim AUTH-ADMIN-001 --apply    # write it, after reviewing
```

```text
Annotation preview: preview — file-level authoring, not verification or intent authentication.
  add src/auth.mjs: AUTH-ADMIN-001
No files changed. Review this selection, then rerun with --apply; the plan is recomputed against current files.
```

- It places a file-header comment in JavaScript, TypeScript or Python files.
  Select claims by repeating `--claim` or with comma-separated ids.
- Every invocation recomputes its plan; a preview is not a saved approval.
  `--out` is refused; `--json` output conforms to
  [`annotations.schema.json`](../../spec/schemas/annotations.schema.json) and
  carries no source contents or verdicts.
- An unsupported, ambiguous or unsafe target blocks the whole selection.
  Files are capped at 2 MiB each and 16 MiB in total. BOM, shebang, Python
  encoding cookie, newline style and permissions are preserved.
- `--apply` takes an exclusive lock and keeps fsynced originals in an
  owner-only recovery directory outside the checkout, whose path it prints. It
  never reclaims an existing lock or rolls back over your edits. It is
  recoverable, not atomic: an interruption can leave partial content, so
  compare the retained originals before recovering.
- A claims file outside the project can be previewed but cannot authorize
  writes.
- Exit codes: preview `0` when applicable, `2` when refused; apply `0` only
  after verified completion, `2` on refusal or partial failure; `3` for
  malformed options.

Placement is file-level. It is not symbol ownership or proof of anything, and
it does not change claim origins, evidence or baselines.

## From proposal to claim: scaffold, sweep and concerns

Writing a fault by hand means reading the code to find an exact anchor. Field
reports found that about 80% of hand-written faults are one of nine shapes, so
TestGuard proposes them. Everything it proposes is a **draft**: never your
claims file, never a verdict.

### scaffold

```bash
npx testguard-cli scaffold src/auth.ts                         # draft at .testguard/scaffold-auth.json
npx testguard-cli scaffold src/auth.ts --claim AUTH-ADMIN-001  # every proposal under one claim; copies it if it exists
npx testguard-cli scaffold src/auth.ts --json                  # print the draft instead of writing it
```

| Shape | What it proposes (JavaScript and TypeScript) |
|---|---|
| `condition-forced` | `if (<guard>) {` → `if (false) {`, where the guard is a `!…` condition or one whose body returns, throws or responds 4xx |
| `statement-deleted` | a single-line guard (`if (…) return …;`) or a state change (`x = …;`) removed |
| `return-altered` | `return <check>;` (`===`, `.includes(`, `&&`, …) → `return true;` |
| `literal-changed` | `httpOnly`/`secure` flipped, `sameSite` → `none`, a cost or rounds → `1`, a ttl/tolerance/window/limit ×1000 |
| `call-removed` | a bare `verify…()` / `validate…()` / `check…()` / `authorize…()` call removed |
| `field-dropped` | a field removed from an object that is returned, built by an arrow, assigned to a payload-like name, passed to a `save`/`update`/`send`/`write`/… call, or a `z.object({…})`-style schema; a string removed from an allow-list array; a `...base` spread dropped. Only a line that can go on its own, and never inside tests, fixtures or migrations |
| `argument-swapped` | a call kept, its first argument swapped for `undefined` (and `{}` when the argument is itself a call), only when that argument derives from a parameter of the enclosing function or a request-like value (`req`, `ctx`, `event`, …) |
| `element-removed` | a one-line JSX element, self-closing or paired, removed |
| `handler-dropped` | an `on<Event>={…}` prop removed: the control renders and does nothing |

`scaffold` reads **Python** too and proposes the same classes in Python
syntax: `if <guard>:` → `if False:`, `return <check>` → `return True`,
`verify=True` → `verify=False`, a parameter-derived argument swapped for
`None`, a key dropped from a payload `dict` or an allow-list. Three
differences are deliberate, each to avoid a fault that cannot compile:

- a statement is replaced with `pass`, never deleted, because an emptied block
  is an `IndentationError`;
- a line that leaves a bracket open, or sits inside one opened earlier, is
  never removed;
- module-level dunder assignments (`__version__`, `__all__`) are not proposed,
  because nobody writes a test for them; module-level constants still are.

The two JSX shapes have no Python meaning and are absent rather than faked.

Every proposal's `find` is the exact line with `expectHits`/`occurrence`
computed from the file, so it is valid by construction. Its provenance is
`producer: "derived"`, `defendedBy` is prefilled from the tests that import the
module, and proposals are grouped under a preceding `@claim` annotation or by
enclosing function. Without a supplied id, groups are named `TODO-CLAIM-1`,
`TODO-CLAIM-2`… and statements begin `TODO:`. A proposal becomes a claim only
when a human replaces the statement with the intent, drops the faults that do
not express it, and moves it into `testguard.claims.json`. The heuristics are
deterministic, with no AST and no model; a proposal the tool cannot anchor is
never emitted.

**Appending to a draft you already started.** `--into` adds faults from one
or more source files to an existing draft inside the project, under exactly
one existing claim id, keeping that claim's statement, source and earlier
faults:

```bash
npx testguard-cli scaffold src/auth.ts src/session.ts --into drafts/auth.json --claim AUTH-ADMIN-001 --json  # read-only preview
npx testguard-cli scaffold src/auth.ts src/session.ts --into drafts/auth.json --claim AUTH-ADMIN-001         # update the draft
```

Without `--json` it keeps a private recovery copy outside the checkout and
reports the draft as **unproven**. It refuses the canonical claims, evidence
and baseline paths, a draft outside the project, and conflicting options.
Limits: 32 sources, 2 MiB per source or draft, 16 MiB of source in total,
4,096 generated proposals.

**Inspecting an input before you write intent.** Two read-only modes describe
an authoring input without producing faults:

```bash
npx testguard-cli scaffold --from-document docs/requirements.md --json   # metadata about a plain-text document, not its text
npx testguard-cli scaffold --from-fix <full-commit-id> --json            # the paths a fix commit changed, partitioned
```

Each takes exactly one input and no other options except `--json`. A fix id
must be a full lowercase SHA-1 or SHA-256 commit id with exactly one parent;
documents are capped at 2 MiB. Output goes to stdout only and says
verification was not performed. Document text and commit subjects are
untrusted data, not instructions and not an authenticated claim.

### sweep: no claim needed

When there are no claims yet, `sweep` proposes faults for the changed files
that carry no claim, probes a bounded selection, and reports what a green
suite did not notice:

```bash
npx testguard-cli sweep --changed origin/main                 # propose, probe a bounded selection, report
npx testguard-cli sweep --changed HEAD --include-dirty --cap 20
```

```text
swept 1 of 1 unclaimed changed file against HEAD.
proposed 2 faults, probed 2 (cap 7).
…
  SURVIVED      src/refund.mjs
    [line 2] Guard removed: `if (order.status !== 'paid') return false;` no longer runs.
    test/refund.test.mjs stayed green with this fault applied; add an assertion that fails on it and passes on HEAD. …

These are PROPOSALS, not claims. Keep the ones worth defending: state the
claim, copy its fault into testguard.claims.json, and probe it from then on.
```

A sweep never writes `testguard.claims.json`, and its evidence
(`.testguard/sweep-evidence.json`) never replaces `.testguard/evidence.json`.
Only `survived` and `nocover` exit `1`. Deferred faults beyond the cap are
not a verdict: raise `--cap` or sweep a smaller change.

`--save-paths` aims the same sweep at every file that writes to storage
instead of the diff, and reports the surface first (writes, files, payload
fields) because a finding list without a denominator invites you to assume the
rest is fine. It also states what the defenders could prove at all: when every
defender mocks the persistence layer, a clean result is evidence that nothing
could have measured persistence, not evidence that saving works. A test that
replaced the database proves the call shape, never that the row landed.

### Concerns

One sentence, many files. A claim names one promise precisely, which is why a large application never
finishes writing them. A **concern** names a *kind* of promise and where to
look for it, in `testguard.concerns.json`:

```json
{
  "schemaVersion": 1,
  "concerns": [
    {
      "id": "ADMIN-GUARDS",
      "statement": "Every admin route refuses a caller without the admin role.",
      "severity": "critical",
      "targets": { "kind": "glob", "globs": ["src/routes/admin/**"] },
      "faultClasses": ["guard-removed", "condition-forced", "return-altered"]
    }
  ]
}
```

```bash
npx testguard-cli concerns                      # list this project's concerns and the built-ins
npx testguard-cli sweep --concern ADMIN-GUARDS  # aim a sweep at one
```

`targets.kind` is `glob` (match paths), `write-sites` (every storage write) or
`changed` (whatever diff the caller is measuring). `faultClasses` narrows the
producers; absent or `null` means every class. Two concerns ship built in:
`SAVE-PERSISTS` (what `--save-paths` uses) and `CHANGED-CODE`. There is no
built-in authorization concern, because a guess at "which files check
permissions" is the noise that gets a check switched off; a project that knows
its own auth layer says so in a few lines, as above. Declaring a concern with a
built-in's id replaces it, and the replacement is reported.

A concern is never a claim. It says where to look, the probe says what it
found, and a human states the sentence worth defending. No model is involved,
so every verifying command stays offline.

## When a file carries nothing to claim

`gate` fails on every changed source file with no claim. When a file genuinely
carries nothing to claim (generated code, a thin wrapper whose logic is
claimed elsewhere), excuse it in `testguard.ignore.json` with a reason a
reviewer will accept:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/ignore.schema.json",
  "schemaVersion": 1,
  "entries": [
    {
      "kind": "path",
      "pattern": "src/generated/**",
      "reason": "Generated from the OpenAPI document on every build; the behaviour is claimed where the handlers live.",
      "by": "maintainer",
      "at": "2026-10-01T00:00:00Z"
    }
  ]
}
```

`reason` is required (at least eight characters) because it is the whole point
of the mechanism. Add `expires` where you can: an expired entry excuses nothing
and is reported as `EXPIRED`. `gate` prints every entry it relied on. The full
format is in [configuration](../reference/configuration.md).

## Removing or renaming a claim

Claims can be wrong, superseded or split, so removal is allowed. It is never
silent, because deleting a claim is the cheapest way to make a finding
disappear:

```bash
npx testguard-cli claims --since origin/main
```

```text
REMOVED    AUDIT-ACTOR-001 (high, 1 fault) — last verdict survived
```

`removed-claim` and `removed-fault` exit `1`. A rename that keeps the
statement verbatim is reported as `renamed-claim` and does not; renaming
still changes the fingerprints, so expect the baseline to see new ids. To
excuse a removal, add an ignore entry naming the claim (`kind: "claim"`) or one
fault (`kind: "fault"`, pattern `<claimId>/<faultId>`):

```json
{
  "kind": "claim",
  "pattern": "AUDIT-ACTOR-001",
  "reason": "Split into AUDIT-ACTOR-002 (user actions) and AUDIT-ACTOR-003 (system jobs) in the audit-log rework.",
  "by": "maintainer",
  "at": "2026-10-01T00:00:00Z",
  "expires": "2026-12-31T00:00:00Z"
}
```

Editing a fault is visible the same way: `status` lists a fault whose content
changed after it survived, with its previous verdict, and makes reviewing that
edit the next action. Never make a fault die by editing it; write the test.

## Next

- [Verdicts](../reference/verdicts.md): what each verdict means and the only acceptable fix
- [Using TestGuard with your AI agent](ai-agents.md): let an agent run this loop
- [Adopting TestGuard in an existing project](existing-projects.md)
- [Configuration](../reference/configuration.md): claims, ignore and concerns files in full
