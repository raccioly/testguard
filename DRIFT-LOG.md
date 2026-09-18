# Drift Log

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-18 -->
<!-- docguard:owner @raccioly -->

Deliberate, recorded deviations from `docs-canonical/`. An undocumented
deviation is a defect; a documented one is a decision. Code that knowingly
departs from canon carries a `// DRIFT: <reason>` comment pointing here.

| Date | Document | Deviation | Reason | Review by |
|---|---|---|---|---|
| — | — | none recorded | The canonical set was written against v0.6.0, after the code | — |

## How to record drift

1. Add a row above, naming the canonical document and the exact deviation.
2. Add `// DRIFT: <one line>` at the code site.
3. Set a review date. Drift without an expiry becomes canon by neglect.
4. Either fix the code or amend the canonical document before that date.

## Known tensions not yet drift

These are acknowledged gaps between intent and implementation. They are tracked
as issues rather than drift because the intent has not changed.

| Topic | Intent | Today | Tracking |
|---|---|---|---|
| Gate duration | A release gate a person will wait for | ~25 min cold; one acceptance test is ~15 of it | #67 |
| Probe observability | A running probe reports progress | progress is gated on `stderr.isTTY`, so CI sees silence | #68 |
| Probe robustness | A disturbed run degrades, not crashes | a deleted scratch worktree crashes the run and loses all evidence | #64 |
