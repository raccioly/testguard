# Data Model

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-18 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality negation-load off — the data model is largely a set of prohibitions (no database, no server state, fingerprints never derived from fault text). -->
<!-- docguard:quality passive-voice off — this document describes what happens to documents as they flow through validation, where the artifact is the subject and the actor is irrelevant. -->

> Canonical. Code that contradicts this document is drift.

TestGuard has **no database**. It owns no server, no user accounts and no
persistent service state. Its data model is a set of **JSON documents written
into the repository being verified**, each validated against a published
schema before it is written and after it is read. The schemas are the shared
contract of the Guard tool family and live in `spec/schemas/`.

This matters for audit: every artifact is readable without the tool, diffable
in review, and replayable by anyone holding the repository.

## Entities

| Entity | File | Committed? | Purpose |
|---|---|---|---|
| Claims | `testguard.claims.json` | **yes** | What must be true, and the faults that would make it false |
| Ignore | `testguard.ignore.json` | **yes** | Reviewable scoping; every entry carries a reason |
| Baseline | `.testguard/baseline.json` | **yes** | Frozen debt; gate only the delta |
| Status | `.testguard/status.json` | optional | Snapshot of the state machine |
| Evidence | `.testguard/evidence.json` | no | One run's findings; regenerated |
| Brief | `.testguard/brief.json` | no | The agent's blind-spot block; regenerated |
| Gate | `.testguard/gate.json` | no | Claim coverage of one change; regenerated |
| Replay | written where `--out` says | no | Would the suite have caught bugs that escaped |
| Calibration | beside the replay document | no | Fault class → share of real bugs missed, with a Wilson interval |

## Schema Definitions

Every kind is JSON Schema 2020-12, identified as `urn:claimspec:v1:<kind>`.

A probe carries a `method`, and a run says which method produced it. It
defaults to `fault-injection`, whose required fields — `file`, `find`,
`replace` on a probe; `confirmRuns`, `mode`, `defenders`, `inputs` and the
baseline and probe runs on evidence — are unchanged and are enforced by the
validator rather than merely by the schema. `assertion` and `scan` are
reserved names for tools that verify by reading or scanning; their fields are
defined by their first consumer, not in advance.
`spec/lib/validate.mjs` applies the schema **and** the semantic rules a schema
cannot express. `spec/lib/fingerprint.mjs` is the single fingerprint
implementation every tool must use.

### Claim

A statement, where it came from, which tests defend it, and one or more faults.
Every claim and every fault records `producedBy`, so a human-authored claim can
be told from a mechanically derived one.

### Fault

`{find, replace}` against one file, with `expectHits` and `occurrence` so the
anchor is exact. `faultClass` is one of thirteen values and exists so that
calibration (fault class → real-bug predictiveness) can be computed later.

### Evidence record

The verdict plus everything it rests on: every baseline run, every probe run,
the resolved defenders, which of them merely mock the subject, the input
hashes that make verdict reuse sound, and the rank.

### Verdict

Closed set of seven. Only `killed` is a pass:
`killed`, `survived`, `nocover`, `unverifiable`, `timeout`, `fault-invalid`,
`flaky-defender`.

## Relationships

```
claims.json ──1:N──> claim ──1:N──> fault ──1:1──> evidence record
                       │                              │
                       └── defendedBy ──> test files ─┘
                                                      │
baseline.json ──suppresses by fingerprint────────────┘
                                                      │
status.json ◀── derived from claims + evidence + baseline + working tree
brief.json  ◀── derived from evidence + baseline + status
```

A fingerprint is `sha256(claimId \n subjectId \n file \n verdict)`. It is
derived from identity and outcome, never from the fault's text, so repairing a
rotted anchor does not churn the baseline, while a change of verdict does
surface as new.

## Indexes

Not applicable — no database. The equivalent lookups are all in-memory maps
built per run: fault key (`claimId/faultId`) to record for verdict reuse, and
target file to importing tests for defender discovery.

## Migration Strategy

The contract is versioned by `schemaVersion` inside every document and by the
`urn:claimspec:v1:` identifier on every schema.

- **Additive change** (a new optional field): no migration; older readers
  ignore it, and `additionalProperties: false` means the field must be added to
  the schema in the same change that emits it.
- **Semantic change** (a new verdict, a new fault class, a changed rule): a
  spec change. The schema, `GATE-SEMANTICS.md`, the validator's semantic rules,
  a conformance example, a must-reject document and the known-answer fixture
  all change together, in the same pull request.
- **Breaking change**: a new `urn:claimspec:v2:` identifier. None has been
  needed.
- **Regenerated artifacts** (evidence, brief, gate) need no migration: delete
  and re-probe. **Committed artifacts** (claims, ignore, baseline) do, and the
  baseline additionally carries the commit it was frozen at, so a stale one is
  visible rather than silently authoritative.

## Revision History

| Version | Date | Change | Author |
|---|---|---|---|
| 1.0.0 | 2026-09-18 | First canonical data model, written against v0.6.0 | @raccioly |
