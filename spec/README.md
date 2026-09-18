# claimspec — the contract spine

Nine formats for declaring what must be true about a codebase, recording the
evidence that tried to falsify it, and gating only what is new.

They are shared as *formats*, not as code. The first tools to adopt them are
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (Node ESM) and
[`websec-validator`](https://pypi.org/project/websec-validator/) (Python) —
porting one runtime into the other was never worth it, and never the point. A
tool conforms by emitting these shapes; it keeps its own language, CLI and UX.

The method they have in common:

> declare what must be true → try mechanically to falsify it → freeze a
> baseline → gate only the delta → brief the agent before it writes code.

**Falsifying by fault injection is one method, not the definition.** A tool
that verifies a claim by reading code, by scanning a surface, or by replaying
history is as much a consumer as one that mutates source. The formats that
carry *how* a claim was tested say which method produced them; the formats
that carry claims, baselines, scoping and briefs do not care.

## Formats

| Kind | Schema | Purpose |
|---|---|---|
| `claims` | [`schemas/claims.schema.json`](schemas/claims.schema.json) | What must be true, and one or more concrete faults that would make it false. Producer-agnostic: a human, an operator, an agent, or a derivation may all emit the same fault shape, and every artifact says which. |
| `evidence` | [`schemas/evidence.schema.json`](schemas/evidence.schema.json) | One run's findings on disk, readable without the tool. Every verdict carries every run that produced it. |
| `baseline` | [`schemas/baseline.schema.json`](schemas/baseline.schema.json) | Frozen fingerprints of existing debt. Gate only what is new. |
| `ignore` | [`schemas/ignore.schema.json`](schemas/ignore.schema.json) | Reviewable scoping. Every entry has a reason. |
| `calibration` | [`schemas/calibration.schema.json`](schemas/calibration.schema.json) | The observed rate of a bucket's outcome — what it measures is in the document — with a Wilson interval and the sample size behind it. Every number is recomputable and the validator recomputes it; provenance, a producer floor, backoff tiers and a labelled fallback ride along so a second tool's honesty survives translation. |
| `brief` | [`schemas/brief.schema.json`](schemas/brief.schema.json) | What to tell an agent before it writes code — ranked, capped, never a single score, and carrying the one next action. |
| `status` | [`schemas/status.schema.json`](schemas/status.schema.json) | Where the project is and what happens next — the single machine-readable truth every human rendering derives from. Surfaces faults whose content changed since they were probed, and changed files that carry no claim. |
| `replay` | [`schemas/replay.schema.json`](schemas/replay.schema.json) | Would this suite have caught the bugs that already escaped? Replays real fix commits: revert the source, remove the test the fix shipped, run what remains. A replayed bug is ground truth — a human already confirmed it was a defect — which is what a fault model is calibrated against. |
| `gate` | [`schemas/gate.schema.json`](schemas/gate.schema.json) | Claim coverage of one change: which changed files carry a claim, which are excused (and by which ignore entry), which are unclaimed. The delta gate for code that has no claim yet. |

Shared definitions (verdicts, fault classes, provenance, annotations) live in
[`schemas/common.schema.json`](schemas/common.schema.json). Gate behaviour —
which verdicts turn CI red, baseline and delta rules, exit codes — is in
[`GATE-SEMANTICS.md`](GATE-SEMANTICS.md).

Schemas are JSON Schema 2020-12 and identified as `urn:claimspec:v1:<kind>`.

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

Adoption is additive and optional: an existing tool gains an output writer, and
nothing it already detects or already writes changes. That holds today for
`baseline`, `ignore`, `brief`, `status` and `calibration` — websec-validator's
shipped calibration table is `conformance/examples/calibration-websec.json`,
translated field for field with its corpus, caveat, floor, backoff and
fallback intact. It does **not** yet hold for
`claims` and `evidence`, whose required fields assume fault injection
(`find`/`replace` anchors, `confirmRuns`, `baselineRuns`/`probeRuns`,
`defenders`) — a tool that scans or reads would have to emit empty arrays to
satisfy the schema, which is conforming by lying. Making those two kinds
method-agnostic is tracked as
[#81](https://github.com/raccioly/testguard/issues/81) and blocks adoption of
either.
