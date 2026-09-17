# Known-answer fixture

A tiny project with a stated claim list and a **known probe result for every
verdict** TestGuard can emit. It is the oracle for `testguard probe`: the tool
is correct when running it here reproduces [`expected.json`](expected.json)
exactly.

This fixture proves the tool's *mechanics* — inject, run, restore, classify,
confirm over N runs. It cannot prove the tool finds real blind spots in real
code; a fixture authored to yield a given answer necessarily yields it. That
evidence comes from running against a real codebase with real history.

## Claims

| Claim | Statement | Fault | Expected |
|---|---|---|---|
| REDACT-001 | The audit row never contains the original input | F1 raw input in row | **survived** — the exhibit |
| | | F2 masking skipped | killed |
| | | F3 `content` field dropped from the row (`field-dropped`) | **survived** — same blind spot as F1 |
| REDACT-002 | An invalid rule pattern is skipped, never aborts | F1 rethrow | killed |
| REDACT-003 | A missing scope fails closed (`@claim` annotation in source) | F1 guard removed | **survived** |
| REDACT-004 | `redact()` settles for every input | F1 never settles | timeout |
| REDACT-005 | `findRule()` returns null for unknown id | F1 rotted anchor | unverifiable (anchor-missing) |
| | | F2 ambiguous anchor | unverifiable (anchor-ambiguous) |
| REDACT-006 | `mask()` replaces with equal-length asterisks | F1 syntax error | fault-invalid |
| EXPORT-001 | Exported rows never include `content` | F1 keeps content | nocover |
| EXPORT-002 | `exportRows()` strips `content` (no `defendedBy`; the only importing test **mocks** the module) | F1 keeps content | nocover — a mock is not a defender; evidence lists it under `mocking` with `mocked-never-asserted` |
| FLAKY-001 | (defender is flaky) | F1 anything | flaky-defender |
| REDACT-007 | `redact()` masks with the configured rules | F1 `mask(input, [])` (`argument-swapped`) | killed — the audit-row test notices nothing was masked |
| DISCOVER-001 | Every match is replaced (no `defendedBy`) | F1 loop body removed | killed — defenders **discovered** by import |

## The exhibit — REDACT-001/F1

`test/redact.test.mjs` checks the audit row with

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);
```

`objectContaining` ignores keys it does not list, and `content` is not
listed. Swap `content: redacted` for `content: input` and the row carries the
raw secret — and the test stays green. Coverage of that line is 100%. This is
the failure mode that motivated the tool, reproduced in ten lines.

## Flaky by design

`test/flaky.test.mjs` fails on every odd-numbered run, using a counter file
next to the fixture. That makes the fixture's own `npm test` unreliable **on
purpose**: it is how the `flaky-defender` verdict is exercised. The root
project's test config excludes this directory.
