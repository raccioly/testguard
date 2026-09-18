# Known-answer fixture — Python

A tiny Python project with a stated claim list and a **known probe result for
every verdict** TestGuard can emit. It is the oracle for `testguard probe` on
Python: the tool is correct when running it here reproduces
[`expected.json`](expected.json) exactly — under **both** engines, stdlib
`unittest` and `pytest`.

Running it under two engines is the point. They have different report shapes
and different notions of failure, and they must still agree on all sixteen
verdicts. If the adapter were guessing, they would not.

Like the JavaScript fixtures, this proves the tool's *mechanics* — inject,
run, restore, classify, confirm over N runs. A fixture authored to yield a
given answer necessarily yields it. Evidence that the tool finds real blind
spots comes from running against a real codebase with real history.

## Claims

| Claim | Statement | Fault | Expected |
|---|---|---|---|
| REDACT-001 | The audit row never contains the original input | F1 raw input in the row | **survived** — the exhibit |
| | | F2 masking skipped | killed |
| | | F3 `content` key dropped (`field-dropped`) | **survived** — same blind spot as F1 |
| REDACT-002 | An invalid pattern is skipped, never aborts | F1 re-raise | killed |
| REDACT-003 | A missing scope fails closed (`@claim` annotation in source) | F1 guard removed | **survived** |
| REDACT-004 | `redact()` returns for every input | F1 never returns | timeout |
| REDACT-005 | `find_rule()` returns None for an unknown id | F1 rotted anchor | unverifiable (anchor-missing) |
| | | F2 ambiguous anchor | unverifiable (anchor-ambiguous) |
| REDACT-006 | `mask()` replaces with equal-length asterisks | F1 syntax error | fault-invalid |
| REDACT-007 | `redact()` masks with the configured rules | F1 `mask(text, [])` (`argument-swapped`) | killed |
| EXPORT-001 | Exported rows never include `content` | F1 keeps content | nocover — the declared defender does not exist |
| EXPORT-002 | `export_rows()` strips `content` (no `defendedBy`; the only importing test **patches the module**) | F1 keeps content | nocover — with `mocked-never-asserted` |
| FLAKY-001 | (defender is flaky) | F1 anything | flaky-defender |
| DISCOVER-001 | Every match is replaced (no `defendedBy`) | F1 loop body removed | killed — defenders **discovered** by Python module name |
| PATCHED-001 | `mask()` replaces with equal-length asterisks (defender patches one attribute) | F1 one asterisk per match | killed — with `target-attribute-patched` |
| UNREACHED-001 | Only an administrator is allowed | F1 always allows | **survived**, `targetNotImported` |

## The exhibit — REDACT-001/F1

`tests/test_redact.py` checks the audit row with

```python
self.assertEqual(row["action"], "MASK")
self.assertEqual(row["scope"], "g1")
self.assertEqual(row["rule_count"], 1)
```

Three keys named, `content` not among them. Swap `redacted` for `text` and the
row carries the raw secret — and the test stays green. Line coverage of that
line is 100%. Removing the key entirely (F3) is invisible the same way.

`testguard scaffold demo/redact.py` proposes the F3 shape on its own, from the
line alone.

## Two things this fixture exists to pin down

**`patch()` is not `vi.mock()`.** `PATCHED-001`'s defender patches
`demo.redact.compile_rules` and exercises `mask` for real. The JavaScript rule
— drop any file that mocks the target — would report that claim as `nocover`,
which is false: the test notices the fault immediately. Only a patch of the
**module itself** (`EXPORT-002`) removes a defender. An attribute patch keeps
it and raises `target-attribute-patched`, naming the attributes.

**A fault that never runs is not a survivor.** `UNREACHED-001`'s declared
defender never imports `demo/orphan.py`. The fault is applied, the suite is
green, and nothing about the tests' assertions has been learned. The record
carries `detail.targetNotImported` so that `survived` cannot be read as
"the tests are blind here" when the truth is "the tests were never there".

## Timeouts cost wall-clock

Python has no per-test timeout without a plugin, so `REDACT-004` ends at
TestGuard's process budget rather than at a test timeout. `expected.json`
carries the `budgetMs` the oracle was measured with (20s); a smaller budget
risks turning a slow machine's ordinary run into a TIMEOUT verdict elsewhere.

## Flaky by design

`tests/test_flaky.py` fails on every odd-numbered run, using a counter file
next to the fixture. That makes this suite deliberately unreliable **on
purpose**: it is how the `flaky-defender` verdict is exercised. The root
project's test config excludes `fixtures/`, and the fixture is only ever run
by the tool's own tests.

## Verification

Every expectation was verified by applying the fault by hand and reading
`python -m unittest`'s own exit code — not TestGuard's reporter — before it
became the oracle. Doing it the other way round would make the fixture agree
with the tool by construction.
