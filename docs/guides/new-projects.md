# Starting a new project with TestGuard

This guide is for a new repository that has no code yet, or very little. This
is the cheapest time to adopt TestGuard. There is no backlog of unclaimed code
and no baseline of old debt. The approach is simple: **write the claim before
the code**, and let the gate keep it that way from the first pull request. For
a codebase that already exists, see
[Adopting TestGuard in an existing project](existing-projects.md).

## Day one: install the agent layer

```bash
npm i -D testguard-cli         # pin it; the session-start hook prefers this install
npx testguard-cli init         # skill, session-start hook, AGENTS.md section, .gitignore lines
```

Commit what `init` wrote. From now on, every agent session starts with the
brief, and the first action of the agent is `testguard status --json`. On an
empty repository, it says `no-claims` and exits `2`. There is nothing to probe
yet, and that is the honest answer. [AI agents](ai-agents.md) shows what each
harness gets. [Installation](../installation.md) shows other install methods.

Create an empty claims file, so that the project has a place for its promises:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": []
}
```

A plain `probe` on an empty claims file exits `2` with
`claims file declares no claims; nothing to verify`. This is on purpose. A
green check over nothing would be good news that nobody earned. While you have
no claims, `probe --allow-empty` exits `0` and says that it skipped
verification. In the meantime, `gate` keeps new code honest.

## The order of work for each behaviour

Take one promise at a time. This example comes from an orders service:
*"Applying a discount never takes an order total below zero."*

1. **Write the statement and where it came from.** The intent comes from a
   requirement, a ticket or an ADR. It does not come from code, because that
   code does not exist yet. This is the advantage of starting here: the claim
   is independent of the implementation by construction.
2. **Write the test, and watch it fail.** There is no implementation, so the
   test is red for the right reason.

   ```js
   test('a discount larger than the total leaves the order at zero, never below', () => {
     assert.equal(applyDiscount(30, 50), 0);
   });
   ```

3. **Write the code** until the test is green.

   ```js
   export function applyDiscount(total, discount) {
     return Math.max(0, total - discount);
   }
   ```

4. **Write the fault.** The `find` of a fault must match the source exactly.
   So you can write a fault only after the line that it breaks exists. Write
   the edit that would make your statement false:

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

5. **Prove that the test defends the claim** before you commit:

   ```bash
   npx testguard-cli claims --check-anchors                               # the anchor matches, the replacement parses
   npx testguard-cli admit test/discount.test.mjs --claim ORDER-TOTAL-001 # green on HEAD, red on the fault, 3/3
   ```

   ```text
     killed          ORDER-TOTAL-001/F1  The zero floor is removed, so a large discount produces a negative total.

   ADMITTED — test/discount.test.mjs passes on HEAD and fails on the fault of ORDER-TOTAL-001, 3/3. Commit it.
   ```

Steps 1 and 2 give the most value. You write the test against the statement,
not against an implementation that the author has already read. So the test
cannot simply encode what the code happens to do. Steps 4 and 5 then prove
that the test is strong enough to notice when the promise breaks.
[Writing claims](writing-claims.md) explains how to choose faults and
defenders.

## Gate from the first pull request

Turn the gate on before there is anything to excuse:

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # before each commit
npx testguard-cli gate --changed origin/main            # in CI, on each pull request
```

Every changed source file must carry a fault, or an ignore entry with a reason
must excuse it. One unclaimed file makes the command exit `1`. In a new
repository this costs almost nothing, because each file arrives with its claim.
If you start later, the same rule means that you read a list of every file that
nobody ever claimed. CI setup is in [GitHub Actions](ci/github-actions.md),
[GitLab](ci/gitlab.md) and [pre-commit](ci/pre-commit.md).

Run the full `probe` in CI as well. Freeze a `baseline` only if something is
truly unproven and you decide to accept it for now. A new project with a clean
probe has no debt to freeze.

## Keep claims small

- **One promise per claim.** "A caller without the admin role is refused" and
  "an admin's session expires after 15 minutes" are two claims, even if one
  function implements both.
- **Few faults per claim.** After a green baseline, each fault runs its
  defenders three times with the fault applied. Two precise faults cost less
  and are clearer than ten loose ones.
- **Point each claim at its fastest honest defender.** If you can state a rule
  in three lines, you should not need a fifty-second end-to-end test to falsify
  it. Extract the decision into a pure function and unit-test that function.
  See [performance](performance.md).
- **Prefer exact assertions.** A partial matcher such as
  `expect.objectContaining({…})` cannot fail on a field that it does not name.
  This blind spot caused the largest gap in the field reports of TestGuard.

## What a new project cannot use yet

`replay` measures whether a suite would have caught bugs that already escaped.
It does this by running real fix commits again. A new project has no fix
commits, so `replay` has nothing to measure.

The open question is whether a **calibration** that you learn on a repository
with history (how often bugs of each fault class escape) also applies to a
repository with no history. This transfer is **unproven**. It is the core bet
behind the product. `replay` is the instrument that tests the bet. It is not
the answer. Nothing that TestGuard gates on comes from another repository.
TestGuard uses one outside measurement: the ordering of `sweep`. The ordering
starts from a shipped prior and says so, until your own evidence replaces the
prior. That ordering decides what to probe first and never decides a verdict.
Until your own history exists, the evidence for a new project is its probes:
every claim killed, N out of N. After you ship fixes, run `replay` from time to
time. See [replay](replay.md).

Independence also starts low. In a young repository, most kills are
`co-authored`: the test and the code arrived in the same change. The brief says
so. This is expected for test-first work by one author. It becomes a concern
only when it never changes. Tests that someone else writes later, against the
same claims, raise independence.

## Next

- [Writing claims](writing-claims.md): fields, faults, defenders and worked examples
- [Using TestGuard with your AI agent](ai-agents.md)
- [GitHub Actions](ci/github-actions.md)
- [How TestGuard works](../concepts/how-it-works.md)
