# Known-answer fixture — mixed defenders (vitest + Playwright)

The oracle for the Playwright adapter and for **per-file runner selection**:
files under Playwright's `testDir` (`e2e/`) run under Playwright, everything
else under the project runner (vitest), and one claim may list both.

The specs are **browserless on purpose**: none requests `page`, so they run
wherever `@playwright/test` is installed. The adapter under test is the
report protocol (`expected` / `unexpected` / `flaky` / `timedOut` / `skipped`)
and the split of defenders across runners; a spec that drives a browser is
run exactly the same way. Dependencies live in this directory's own
`package.json`, never in the tool's: `npm ci` here before running.

## Claims

| Claim | Statement | Fault | Defenders | Expected |
|---|---|---|---|---|
| TOGGLE-001 | the row renders a checkbox toggle | F1 checkbox removed (`element-removed`) | vitest only | **survived** — the unit test checks the label text only |
| TOGGLE-002 | same | same | Playwright only | killed |
| TOGGLE-003 | same | same | both | killed — `defenders.byRunner` says which file ran where |
| TOGGLE-004 | the toggle carries its change handler | F1 `onchange` dropped (`handler-dropped`) | Playwright | killed |
| TOGGLE-005 | `renderToggle()` returns promptly | F1 never settles | Playwright | timeout (`timedOut` is never a kill) |
| FLAKY-PW | (defender passes only on retry) | F1 anything | Playwright, `retries: 1` | flaky-defender — Playwright exits 0 and says `flaky`; that is not green |

## Flaky by design

`e2e/flaky.spec.mjs` fails on every odd attempt using a counter file beside
the fixture; with `retries: 1` each run reports it `flaky`. A green exit code
that hides a first-attempt failure is exactly what the adapter must not call
green.
