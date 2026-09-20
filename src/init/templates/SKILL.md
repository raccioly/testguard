---
name: testguard
description: Prove the test suite defends this project's claims. Use before writing or changing tests, after changing guarded code, and whenever a session starts with a TEST BLINDSPOT CONTEXT block.
---

# TestGuard — how an agent runs it

TestGuard injects the faults a project's claims forbid and reports every one
the tests fail to detect. It is a **claim verifier**, not a test generator.
You operate it through one loop and one source of truth.

## The one source of truth

```bash
testguard status --json
```

Read `state` and `next`. Do what `next.command` says. Never infer state from
which files exist. `state` is one of:

| state | meaning | you do |
|---|---|---|
| `no-claims` | no `testguard.claims.json` | `testguard scaffold <file>` for a file with guards; replace every `TODO:` statement with what the code guarantees; keep or drop each proposal; move the claims into `testguard.claims.json` |
| `unclaimed-changes` | files you changed carry no claim (when a reference is explicit, supplied by CI, or safely inferred from local Git's remote default/upstream metadata) | `next.file` names the first; `testguard scaffold <file>` and state the claim, or add a `testguard.ignore.json` path entry with a reason a reviewer will accept. **Before** writing more code. |
| `invalid-anchors` | an exact fault anchor moved or became ambiguous | run `testguard claims --check-anchors`; repair `next.target` in the claims file without changing what the fault means, then re-probe. Never guess or auto-fix an anchor. |
| `unprobed` | claims never probed | `testguard probe` |
| `evidence-stale` | code, tests or claims changed since the evidence | `testguard probe --include-dirty` (or `--claim <ID>` for one) |
| `provisional-only` | only `--confirm 1` evidence exists | `testguard probe --confirm 3` |
| `unproven` | a finding is not covered by the baseline | `next.target` names it; see the verdict table |
| `clean` | everything killed or baselined | `testguard baseline` if `next` says so; otherwise nothing |

Exit codes: `0` clean · `1` unproven claims (or drift, or unclaimed changes) · `2` precondition failed / nothing to do yet · `3` usage.

## Every change needs a claim

`probe` verifies only the claims that exist; it is silent about unclaimed
code by construction. So, for every source file you create or change:

1. `testguard gate --changed HEAD --include-dirty` (the pre-commit shape; in a
   PR, `--changed origin/<base>`). One unclaimed file exits `1`.
2. For each `UNCLAIMED` file: `testguard scaffold <file>` proposes faults;
   state what the code guarantees; add the claim, its faults and its
   `defendedBy` to `testguard.claims.json`. A new test file must be named in
   some claim's `defendedBy`, or it is unclaimed too.
3. Only when a file genuinely carries nothing to claim (generated code, a
   thin wrapper whose logic is claimed elsewhere): a `path` entry in
   `testguard.ignore.json` with a reason and, where possible, an `expires`.
   The gate prints every entry it relied on; a reviewer reads them.
4. After editing guarded code, run `testguard claims --check-anchors`. Repair
   any named fault definition without weakening its meaning; the check never
   relocates an anchor for you.
5. Then `testguard admit <test-file> --claim <ID>` for the new claim's test (or `testguard probe --claim <ID> --include-dirty` for the full report).

## Verdict → action

| verdict | what it means | the only acceptable fix |
|---|---|---|
| `SURVIVED` | the defenders stayed green while the claim was false | **write a test** in the defender file that fails with the fault applied and passes on HEAD |
| `SURVIVED [killed-by-undeclared-tests: …]` | other tests catch it | add those files to the claim's `defendedBy` |
| `NOCOVER` | no test file imports the target | write a new test file that imports it and asserts the claim |
| `UNVERIFIABLE` | the fault's anchor no longer matches, or the defenders fail to load | fix the **fault definition** (or the defenders' import); never the code |
| `FAULT-INVALID` | the replacement does not compile | fix the fault definition |
| `TIMEOUT` | the fault makes the code hang | write an assertion that fails on it; a hang is not a detection |
| `FLAKY-DEFENDER` | defenders not green 3/3, or disagreed across runs | fix the flake first; no verdict is trustworthy until then |

## The fix loop

1. `testguard status --json` → take `next.target`.
2. Write the test. It must **fail when the fault is applied and pass on HEAD**. To check the first half by hand: apply `find` → `replace` in the target file, run the defender, restore.
3. `testguard admit <test-file> --claim <ID>` — the two gates as one verb, on your uncommitted test, without touching the tree: `ADMITTED` (exit 0) means the test is green on HEAD and fails on every fault of the claim, 3/3; `NOT ADMITTED` (exit 1) names the first blocking fault and what to do. `--fault <FID>` judges one fault; `--confirm 1` gives a fast **provisional** `ADMITTED?` that must be confirmed at 3 before you commit. (`testguard probe --claim <ID> --include-dirty` is the same run with the full report.)
4. When it is `ADMITTED` at `--confirm 3`, commit the test.
5. When everything is killed or baselined, `testguard baseline` if `next` says so, and commit `.testguard/baseline.json`.

## Rules that are not yours to bend

- **Never make a fault die by editing the claims file.** Editing a claim is allowed when the claim was wrong — but the evidence records every fault's content hash, and `status` lists any fault edited after it survived, with its previous verdict, as `changedFaults`. The change is permitted; it is never invisible. Say why in the commit.
- **A test that asserts current behaviour is not a fix.** If the test would pass with the fault applied, it defends nothing.
- **Never re-implement the code under test inside the test.** Drive the real function; assert the outcome, not that a function was called.
- `--confirm 1` results are provisional: they print with `?`, go to `evidence-provisional.json`, and cannot be baselined.
- Worktree mode probes a **commit**. If `probe` refuses because defenders are dirty, use `--include-dirty`; do not commit half-written tests to satisfy it.
- Do not add `.testguard/evidence.json` or `brief.json` to git; do commit `baseline.json`.

## Reading the numbers

`N unproven faults across M claims` counts faults and the claims they belong to. There is no single score on purpose: blindness is concentrated, and one number hides where.
