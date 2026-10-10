# Routine: scaffold-hunt (weekly)

Find faults in one claimed source file that the suite does not notice, and
defend the ones that break a behaviour TestGuard promises. This is TestGuard
applied to itself: the thinnest-claimed files are hunted first.

Follow `.jules/RULES.md` throughout.

## Steps

1. Run `node .jules/preflight.mjs scaffold-hunt`. On STOP, end the task. On
   GO, the `target:` line is the one file you work on.
2. Propose faults mechanically. The draft is gitignored; do not commit it.

   ```bash
   node cli/testguard.mjs scaffold <target> --out .testguard/scaffold-hunt.json
   ```

3. Probe the proposals. This takes three runs per fault and re-runs survivors
   against the whole suite.

   ```bash
   node cli/testguard.mjs probe . --claims .testguard/scaffold-hunt.json \
     --out .testguard/scaffold-hunt-evidence.json --quiet
   ```

   Keep only the records whose verdict is `survived`. A timeout, a flaky
   defender or an unverifiable fault is not a finding.
4. If nothing survived, end the task with no pull request. The summary says
   which file was hunted and that every proposed fault was killed.
5. For each survivor, up to three, find a written promise it breaks.

   **Where to look:**
   - `README.md` and `docs/`
   - `spec/GATE-SEMANTICS.md`
   - `CHANGELOG.md`
   - the statement of an existing claim

   **What to do:**
   - If you find one, quote it. That quote is the intent.
   - If none exists, drop the survivor and list it under **Dropped** with the
     reason: an equivalent change, an internal detail, or not promised.
   - Never derive a promise from the implementation itself. A test that pins
     what the code happens to do is the defect TestGuard exists to catch.
6. For each kept survivor, write a test in a **new** file
   `test/<area>-<behaviour>.test.mjs`. It must fail with the fault applied and
   pass without it. Prove both by hand: apply the fault's find/replace, run
   `npx vitest run <new test>` and see it fail, revert, and see it pass.
7. Record the fault in `testguard.claims.json`.
   - Append it to the existing claim whose statement covers the quoted
     promise, with `"producedBy": { "producer": "agent", "by": "jules" }`.
   - Add the new test to that claim's or that fault's `defendedBy`.
   - If no claim fits, add a new claim whose `source.ref` points at where the
     promise is written.
8. Run the checks in `.jules/RULES.md` §4, including the probe of every claim
   you touched.
9. Open the pull request. The title is the preflight title, with a summary
   such as `two survivors defended`.

A claims change always waits for maintainer review. That is expected.
