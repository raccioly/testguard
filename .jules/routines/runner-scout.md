# Routine: runner-scout (weekly)

Build one realistic project shape that a TestGuard user is likely to have,
probe it, and check the verdicts are right. Field bugs live in runner and
layout variants that the repository's fixtures do not cover.

Follow `.jules/RULES.md` throughout.

## Steps

1. Run `node .jules/preflight.mjs runner-scout`. On STOP, end the task. On
   GO, the `scenario:` line describes the one project shape you build.
2. Build the smallest project with that shape **outside the repository**,
   for example in `$(mktemp -d)`. It contains:
   - one source module with two independent behaviours;
   - one test that asserts the first behaviour only;
   - a `testguard.claims.json` with one claim and two faults. F1 breaks the
     first behaviour, so the test kills it. F2 breaks the second, so it
     survives. Fill `defendedBy` with that test file.
   - a git repository with everything committed.

   Install only what the scenario names: npm or pip packages, inside that
   directory.
3. Probe it with this checkout's CLI:

   ```bash
   node <repo>/cli/testguard.mjs probe <dir> --quiet --json > probe.json
   node <repo>/cli/testguard.mjs status <dir> --json
   ```

   The expected result is F1 `killed` and F2 `survived`, with the runner the
   scenario implies named in the evidence.
4. If that is exactly what you got, end the task with no pull request. The
   summary says the scenario works, with the commands and verdicts.
5. Otherwise, decide whose defect it is:
   - **The scenario's own setup.** Run the scenario's runner directly. If its
     own test command fails, or its config is wrong, fix the scenario and go
     back to step 3. Never open a PR for a scenario mistake.
   - **TestGuard's.** It errored, picked the wrong runner, missed or
     misattributed a defender, or gave a wrong verdict. Reduce it to the
     smallest reproduction.
6. For a TestGuard defect:
   - **Regression test:** write it in a **new** file under `test/`. Build the
     reproduction in a temporary directory, as existing tests do. Make
     fixture commits through `FIXTURE_GIT` from `test/helpers/git.mjs`. Do
     not add anything under `fixtures/`: those oracles are verified by a
     maintainer.
   - **Fix:** in `src/`, as small as the defect.
   - **Claim:** add a fault for the fix to the claim that covers it, or a new
     claim, then probe it.
   - **Changelog:** add an `[Unreleased]` → `### Fixed` entry to
     `CHANGELOG.md` describing what a user saw.
7. Run the checks in `.jules/RULES.md` §4, then open the pull request.

A change to `src/` always waits for maintainer review. That is expected.
