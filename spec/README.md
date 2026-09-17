# Guard spec — the contract spine

Eight formats that tools following the Guard pattern share. They share
*formats*, not code: [`docguard-cli`](https://www.npmjs.com/package/docguard-cli)
is Node ESM, [`websec-validator`](https://pypi.org/project/websec-validator/)
is Python, and porting one runtime into the other is not worth it. A tool
conforms by emitting these shapes; it keeps its own language, CLI and UX.

The pattern all such tools run:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

## Formats

| Kind | Schema | Purpose |
|---|---|---|
| `claims` | [`schemas/claims.schema.json`](schemas/claims.schema.json) | What must be true, and one or more concrete faults that would make it false. Producer-agnostic: a human, an operator, an agent, or a derivation may all emit the same fault shape, and every artifact says which. |
| `evidence` | [`schemas/evidence.schema.json`](schemas/evidence.schema.json) | One run's findings on disk, readable without the tool. Every verdict carries every run that produced it. |
| `baseline` | [`schemas/baseline.schema.json`](schemas/baseline.schema.json) | Frozen fingerprints of existing debt. Gate only what is new. |
| `ignore` | [`schemas/ignore.schema.json`](schemas/ignore.schema.json) | Reviewable scoping. Every entry has a reason. |
| `calibration` | [`schemas/calibration.schema.json`](schemas/calibration.schema.json) | P(finding is real) per bucket, with a Wilson interval and the sample size behind it. |
| `brief` | [`schemas/brief.schema.json`](schemas/brief.schema.json) | What to tell an agent before it writes code — ranked, capped, never a single score, and carrying the one next action. |
| `status` | [`schemas/status.schema.json`](schemas/status.schema.json) | Where the project is and what happens next — the single machine-readable truth every human rendering derives from. Surfaces faults whose content changed since they were probed, and changed files that carry no claim. |
| `gate` | [`schemas/gate.schema.json`](schemas/gate.schema.json) | Claim coverage of one change: which changed files carry a claim, which are excused (and by which ignore entry), which are unclaimed. The delta gate for code that has no claim yet. |

Shared definitions (verdicts, fault classes, provenance, annotations) live in
[`schemas/common.schema.json`](schemas/common.schema.json). Gate behaviour —
which verdicts turn CI red, baseline and delta rules, exit codes — is in
[`GATE-SEMANTICS.md`](GATE-SEMANTICS.md).

Schemas are JSON Schema 2020-12 and identified as `urn:guard-spec:v1:<kind>`.

## Conformance

`lib/validate.mjs` validates a document of any kind: JSON Schema first, then
the semantic rules a schema cannot express (unique ids, fingerprint
derivation, N-run agreement, green-baseline requirement, interval sanity).
`lib/fingerprint.mjs` is the single fingerprint implementation every tool
must use.

`conformance/examples/` holds one valid document per kind; `conformance/invalid/`
holds documents that must be rejected, each named for its defect. A tool
conforms when its output validates and its behaviour matches
`GATE-SEMANTICS.md`.

```bash
npm run test:spec
```

## Sequencing

The spec is drafted here and validated against `testguard` as its first
consumer. It moves to its own repository only when a second tool adopts it.
Adoption by an existing tool is one additive output writer — no rewrite, no
behaviour change, and optional until that tool wants it.
