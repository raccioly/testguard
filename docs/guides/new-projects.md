# Starting a new project with TestGuard

This guide is for a greenfield repository: no code yet, or very little. It is
the cheapest moment to adopt TestGuard, because there is no backlog of
unclaimed code and no baseline of old debt. The approach is simple to state:
**write the claim before the code**, and let the gate keep it that way from
the first pull request. For a codebase that already exists, see
[Adopting TestGuard in an existing project](existing-projects.md).

## Day one: install the agent layer

```bash
npm i -D testguard-cli         # pin it; the session-start hook prefers this install
npx testguard-cli init         # skill, session-start hook, AGENTS.md section, .gitignore lines
```

Commit what `init` wrote. From now on every agent session starts with the
brief, and the agent's first move is `testguard status --json`. On an empty
repository that says `no-claims` and exits `2`: nothing to probe yet, which is
honest. What each harness gets is in [AI agents](ai-agents.md); other install
methods are in [installation](../installation.md).

Create an empty claims file so the project has a place for its promises:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": []
}
```

A plain `probe` on an empty claims file exits `2` with
`claims file declares no claims; nothing to verify`. That is deliberate: a
green check over nothing would be good news nobody earned. While you have no
claims yet, `probe --allow-empty` exits `0` and says verification was skipped;
`gate` is what keeps new code honest in the meantime.

## The order of work for each behaviour

Take one promise at a time, for example from an orders service: *"Applying a
discount never takes an order total below zero."*

1. **Write the statement and where it came from.** Intent comes from a
   requirement, ticket or ADR, not from code that does not exist yet. That is
   the advantage of starting here: the claim is independent of the
   implementation by construction.
2. **Write the test, and watch it fail.** There is no implementation, so it is
   red for the right reason.

   ```js
   test('a discount larger than the total leaves the order at zero, never below', () => {
     assert.equal(applyDiscount(30, 50), 0);
   });
   ```

3. **Write the code**, until the test is green.

   ```js
   export function applyDiscount(total, discount) {
     return Math.max(0, total - discount);
   }
   ```

4. **Write the fault.** A fault's `find` must match the source exactly, so it
   can only be written once the line it breaks exists. Write the edit that
   would make your statement false:

   ```json
   {
     "id": "ORDER-TOTAL-001",
     "statement": "Applying a discount never takes an order total below zero.",
     "source": { "kind": "spec", "ref": "docs/requirements.md#discounts" },
     "severity": "high",
     "producedBy": { "producer": "human", "by": "maintainer" },
     "defendedBy": ["test/discount.test.mjs"],
     "faults": [
       {
         "id": "F1",
         "description": "The zero floor is removed, so a large discount produces a negative total.",
         "faultClass": "return-altered",
         "file": "src/discount.mjs",
         "find": "return Math.max(0, total - discount);",
         "replace": "return total - discount;",
         "producedBy": { "producer": "human", "by": "maintainer" }
       }
     ]
   }
   ```

5. **Prove the test defends the claim**, before you commit:

   ```bash
   npx testguard-cli claims --check-anchors                               # the anchor matches, the replacement parses
   npx testguard-cli admit test/discount.test.mjs --claim ORDER-TOTAL-001 # green on HEAD, red on the fault, 3/3
   ```

   ```text
     killed          ORDER-TOTAL-001/F1  The zero floor is removed, so a large discount produces a negative total.

   ADMITTED — test/discount.test.mjs passes on HEAD and fails on the fault of ORDER-TOTAL-001, 3/3. Commit it.
   ```

Steps 1 and 2 are where the value is. The test is written against the
statement, not against an implementation the author has already read, so it
cannot simply encode whatever the code happens to do. Steps 4 and 5 then prove
the test is strong enough to notice when the promise breaks. How to choose
faults and defenders is in [Writing claims](writing-claims.md).

## Gate from the first pull request

Turn the gate on before there is anything to excuse:

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # before each commit
npx testguard-cli gate --changed origin/main            # in CI, on each pull request
```

Every changed source file must carry a fault or be excused by an ignore entry
with a reason; one unclaimed file exits `1`. In a new repository this costs
almost nothing, because each file arrives with its claim. Started later, the
same rule means reading a list of every file nobody ever claimed. CI wiring is
in [GitHub Actions](ci/github-actions.md), [GitLab](ci/gitlab.md) and
[pre-commit](ci/pre-commit.md).

Run the full `probe` in CI as well, and freeze a `baseline` only if something
is genuinely unproven and you have decided to accept it for now. A new project
with a clean probe has no debt to freeze.

## Keep claims small

- **One promise per claim.** "A caller without the admin role is refused" and
  "an admin's session expires after 15 minutes" are two claims, even if one
  function implements both.
- **Few faults per claim.** After a green baseline, each fault runs its
  defenders three times with the fault applied. Two precise faults are cheaper
  and clearer than ten loose ones.
- **Point each claim at its fastest honest defender.** A rule you can state in
  three lines should not need a fifty-second end-to-end test to falsify it.
  Extract the decision into a pure function and unit-test that; see
  [performance](performance.md).
- **Prefer exact assertions.** A partial matcher such as
  `expect.objectContaining({…})` cannot fail on a field it does not name, the
  blind spot behind the largest gap in TestGuard's field reports.

## What a new project cannot use yet

`replay` measures whether a suite would have caught bugs that already escaped,
by re-running real fix commits. A new project has no fix commits, so `replay`
has nothing to measure.

The open question is whether a **calibration** learned on a repository with
history (how often bugs of each fault class escape) carries over to one with
none. That transfer is **unproven**: it is the core bet behind the product,
and `replay` is the instrument for testing it, not the answer. Nothing
TestGuard gates on comes from another repository. The one outside measurement
it uses is `sweep`'s ordering, which starts from a shipped prior and says so
until your own evidence overrides it; that decides what to probe first, never
a verdict. Until your own history exists, the evidence for a new project is its
probes: every claim killed, N out of N. Once you have shipped fixes, start running `replay` periodically;
see [replay](replay.md).

Likewise, independence starts low. In a young repository most kills are
`co-authored` (the test and the code arrived in the same change), and the
brief says so. That is expected for test-first work by one author. It becomes
a concern when it never changes: tests written later, by someone else, against
the same claims are what raise it.

## Next

- [Writing claims](writing-claims.md): fields, faults, defenders and worked examples
- [Using TestGuard with your AI agent](ai-agents.md)
- [GitHub Actions](ci/github-actions.md)
- [How TestGuard works](../concepts/how-it-works.md)
