# Quickstart

This page takes you from nothing to a first test that TestGuard has admitted,
in about ten minutes. It is for anyone trying TestGuard for the first time on
a JavaScript or TypeScript project with a green vitest or jest suite. First
you watch it find a real blind spot in the repository's own demo project; then
you run the same loop on a small project of your own. Every block of output
below was captured from a real run; long paths are shortened with `…`.

You need Node ≥ 20 and `git`. Other ways to install, and what each needs, are
in [installation](installation.md).

## 1. Watch it work: the known-answer fixture

The repository ships a tiny project, `fixtures/known-answer/`, built to
produce every verdict TestGuard can emit. Its audit-log test checks the row
with `expect.objectContaining({...})` and never names the `content` field, so
writing the **raw secret** into the audit row keeps the suite green.

```bash
git clone https://github.com/raccioly/testguard.git
cd testguard
npm install                                      # the fixture borrows the repository's vitest
node cli/testguard.mjs claims fixtures/known-answer   # what the fixture claims
node cli/testguard.mjs probe fixtures/known-answer    # try to falsify every claim
```

Inside the TestGuard repository you run the CLI from source as
`node cli/testguard.mjs`, because a package is never installed into its own
`node_modules`. In your own project it is `npx testguard-cli`.

The probe takes seconds on this fixture and exits `1`:

```text
SURVIVED        REDACT-001/F1          critical src/redact.mjs  Audit row carries the raw input instead of the redacted text.
SURVIVED        REDACT-001/F3          critical src/redact.mjs  The content field is dropped from the audit row entirely (the field-dropped shape). Same blind spot as F1: objectContaining never lists `content`.
SURVIVED        REDACT-003/F1          high     src/redact.mjs  Fail-closed guard removed; a missing scope proceeds unscoped.
TIMEOUT         REDACT-004/F1          medium   src/redact.mjs  redact() returns a promise that never settles.  [test-timed-out]
UNVERIFIABLE    REDACT-005/F1          low      src/redact.mjs  Anchor that no longer exists in the source (rotted).  [anchor-missing]
UNVERIFIABLE    REDACT-005/F2          low      src/redact.mjs  Anchor that matches more than once (ambiguous): `return null;` occurs in two functions.  [anchor-ambiguous: 2 hits, expected 1]
FAULT-INVALID   REDACT-006/F1          low      src/redact.mjs  Replacement that does not parse (a bad fault, not a detection).  [replacement-does-not-compile]
NOCOVER         EXPORT-001/F1          medium   src/export.mjs  Export keeps the content field.
FLAKY-DEFENDER  FLAKY-001/F1           low      src/redact.mjs  Any fault at all; the defender's flakiness pre-empts the verdict.  [defenders-not-green]
NOCOVER         EXPORT-002/F1          medium   src/export.mjs  Export keeps the content field. No defendedBy: the only test that imports src/export mocks it and never asserts on it, so discovery must find NO defender — a mock cannot detect a fault in what it replaces.  (defenders discovered by import)

  4 killed (not listed; --verbose to see them)
14 faults probed: 3 SURVIVED, 2 NOCOVER, 2 UNVERIFIABLE, 1 FAULT-INVALID, 1 TIMEOUT, 1 FLAKY-DEFENDER, 4 killed. 10 unproven faults across 8 claims. Probed 379fb6a.
…
evidence: …/fixtures/known-answer/.testguard/evidence.json
```

Read the first line. TestGuard swapped the redacted text for the raw input in
`src/redact.mjs`, ran the audit-row test three times, and it passed every
time. That is `SURVIVED`: the **fault** survived, which is the bad news. A
healthy report is mostly `killed`.

The other verdicts are there on purpose; the fixture's
[README](../fixtures/known-answer/README.md) explains each one, and
[verdicts](reference/verdicts.md) says what to do about each.

## 2. Your own project

The rest of this page runs the loop on a small billing module. Use your own
project if it has a green vitest or jest suite; the commands are the same.

The starting point is one source file and one test:

```js
// src/billing.mjs
export function orderTotal(order) {
  if (!order.items.length) {
    throw new Error('an order needs at least one item');
  }
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (order.coupon === 'HALF' && subtotal >= 100) {
    return { subtotal, total: subtotal / 2 };
  }
  return { subtotal, total: subtotal };
}
```

```js
// test/billing.test.mjs
import { it, expect } from 'vitest';
import { orderTotal } from '../src/billing.mjs';

it('halves an order of 100 or more with the HALF coupon', () => {
  expect(orderTotal({ items: [{ price: 60, qty: 2 }], coupon: 'HALF' }).total).toBe(60);
});
```

### Install and `init`

```bash
npm i -D testguard-cli          # pins the version in your lockfile
npx testguard-cli init          # the agent layer and the .gitignore lines
```

```text
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ .gitignore: 10 lines added

Agents now start with the blind-spot brief and can run `testguard status --json` to learn what to do next. The hook prefers a local install and never fetches from the network.
Commit these files.
```

`init` writes the files an AI agent reads at session start: a skill, a hook
that prints the blind-spot brief, and an `AGENTS.md` section. It also ignores
the `.testguard/` files that are regenerated on every run. If you do not use
an agent, the files are harmless; [AI agents](guides/ai-agents.md) explains
them. Commit them.

### Ask where you are

```bash
npx testguard-cli status        # the state and the ONE next action
```

```text
state: no-claims — 0 claims / 0 faults
surface:  0 of 1 source modules carry a claim; 0 of 1 highest-churn modules claimed (last 3 commits)
UNCLAIMED src/billing.mjs — 1 change in history window; path risk: money
next:     [scaffold] testguard scaffold src/billing.mjs
why:      1 source module exist and none carries a claim. Start with src/billing.mjs, …
```

`status` exits `2`: there is nothing to probe yet. `init` does not create a
claims file, and `claims` and `probe` stop with
`error: cannot read claims file testguard.claims.json` until one exists. Start
with an empty one:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": []
}
```

```bash
npx testguard-cli claims        # 0 claims in testguard.claims.json — exit 0
npx testguard-cli probe         # "claims file declares no claims; nothing to verify" — exit 2
```

`probe` refuses an empty claims file with exit `2`, because a run that
verified nothing must not look like a pass. While you adopt TestGuard in CI,
`probe --allow-empty` skips a valid empty file with exit `0` and says so. See
[GitHub Actions](guides/ci/github-actions.md#adopting-with-zero-claims).

### Let `scaffold` propose faults

```bash
npx testguard-cli scaffold src/billing.mjs    # a draft, never your claims file
```

```text
2 proposed faults in 1 draft claim for src/billing.mjs — 2 condition-forced
defendedBy prefilled from imports: test/billing.test.mjs
draft: .testguard/scaffold-billing.json
Next: Supply intended observable behavior from a requirement, ADR, bug or incident independently of the implementation: …
```

The draft holds mechanical proposals under a `TODO-CLAIM-1` placeholder. Each
fault is an exact source change that would break something:

```json
{
  "id": "S1",
  "description": "[line 2] Guard never triggers: `if (!order.items.length)` becomes `if (false)`.",
  "faultClass": "condition-forced",
  "file": "src/billing.mjs",
  "find": "  if (!order.items.length) {",
  "replace": "  if (false) {",
  "producedBy": { "producer": "derived", "by": "testguard scaffold <version>" }
}
```

A proposal is not a claim. `scaffold` read the code; it does not know what the
code is **meant** to do, and a claim written from the code would only restate
whatever the code does today, bugs included.

### Turn one proposal into a claim

Take the intent from somewhere other than the implementation: a requirement,
a ticket, an incident. Here the billing requirements say an empty order must
be refused. Write that sentence, keep the matching fault, and record where the
intent came from:

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": [
    {
      "id": "BILLING-EMPTY-ORDER",
      "statement": "An order with no items is refused; it never produces a total.",
      "source": { "kind": "spec", "ref": "billing requirements, rule 1" },
      "severity": "high",
      "producedBy": { "producer": "human", "by": "you" },
      "defendedBy": ["test/billing.test.mjs"],
      "faults": [
        {
          "id": "F1",
          "description": "Guard never triggers: an empty order is totalled instead of refused.",
          "faultClass": "condition-forced",
          "file": "src/billing.mjs",
          "find": "  if (!order.items.length) {",
          "replace": "  if (false) {",
          "producedBy": { "producer": "derived", "by": "testguard scaffold" }
        }
      ]
    }
  ]
}
```

Check the anchor before spending a probe on it:

```bash
npx testguard-cli claims --check-anchors    # finds every anchor and parses every replacement; runs no tests
```

```text
  BILLING-EMPTY-ORDER high     spec        1 fault   1 defender    An order with no items is refused; it never produces a total.

OK               BILLING-EMPTY-ORDER/F1  src/billing.mjs — 1 hit, expected 1; javascript syntax ok
anchor preflight: 1 faults checked, 1 ok, 0 invalid in 27ms
```

`claims` also prints an annotation advisory: the claim has no `@claim`
comment in the source. It is optional and does not change any verdict; see
[writing claims](guides/writing-claims.md).

### Probe it

```bash
npx testguard-cli probe         # apply each fault in a scratch worktree and run its defenders
```

```text
  … BILLING-EMPTY-ORDER/F1 baseline 1/3
  … BILLING-EMPTY-ORDER/F1 baseline 2/3
  … BILLING-EMPTY-ORDER/F1 baseline 3/3
  … BILLING-EMPTY-ORDER/F1 probe 1/3
  … BILLING-EMPTY-ORDER/F1 probe 2/3
  … BILLING-EMPTY-ORDER/F1 probe 3/3
  … BILLING-EMPTY-ORDER/F1 negative-control 1/1
SURVIVED        BILLING-EMPTY-ORDER/F1 high     src/billing.mjs  Guard never triggers: an empty order is totalled instead of refused.

1 faults probed: 1 SURVIVED. 1 unproven fault across 1 claim. Probed 13c8d1b.
… No baseline.
evidence: .testguard/evidence.json
```

The probe exits `1`. It first ran the defender three times on unmodified code
(it must be green, or nothing can be concluded), then three times with the
guard disabled. The test stayed green: nothing in the suite checks that an
empty order is refused. Your working tree was never touched; the fault was
applied in a scratch git worktree.

### Read the SURVIVED

`status` and the brief turn the evidence into the next action:

```bash
npx testguard-cli brief --text  # the same block the session-start hook gives an agent
```

```text
## TEST BLINDSPOT CONTEXT

testguard <version> (local install) @ bee6ee9530c6 — 1 claims, 1 faults probed, 1 unproven (no baseline; everything is new).
…
NEXT [write-test]: write a test in test/billing.test.mjs that fails on BILLING-EMPTY-ORDER/F1 and passes on HEAD, then: testguard admit test/billing.test.mjs --claim BILLING-EMPTY-ORDER
  why: BILLING-EMPTY-ORDER/F1 (high) survived: "An order with no items is refused; it never produces a total." can be false with the suite green.

Where the test suite is blind, ranked. A SURVIVED fault means its defenders stayed green while the claim was false.
Do not close these by asserting current behaviour; write a test that fails on the described fault and passes on HEAD.

1. [NEW] SURVIVED  BILLING-EMPTY-ORDER/F1 (high) src/billing.mjs
   claim: An order with no items is refused; it never produces a total.
   test/billing.test.mjs stayed green with this fault applied; add an assertion that fails on it and passes on HEAD. …
```

The fix for a `SURVIVED` is always a test, never an edit to the claims file.
Weakening a fault to make it go away is recorded: `status` lists any fault
edited after it survived.

### Write the test, then `admit` it

```js
// test/billing.test.mjs — add
it('refuses an order with no items', () => {
  expect(() => orderTotal({ items: [] })).toThrow('at least one item');
});
```

```bash
npx testguard-cli admit test/billing.test.mjs --claim BILLING-EMPTY-ORDER
```

```text
  killed          BILLING-EMPTY-ORDER/F1  Guard never triggers: an empty order is totalled instead of refused.

ADMITTED — test/billing.test.mjs passes on HEAD and fails on the fault of BILLING-EMPTY-ORDER, 3/3. Commit it.
evidence: .testguard/evidence-partial.json (partial; not the canonical evidence file)
```

`admit` is the two-gate rule: the new test must pass on unmodified code **and**
fail on every fault of the claim, three runs out of three. It reads your
uncommitted test (it probes a snapshot of the working tree), exits `0` for
`ADMITTED` and `1` for `NOT ADMITTED`, and writes partial evidence so the
canonical file is untouched.

A plain `probe` would refuse here. It probes the committed `HEAD`, and with a
defender edited but not committed it stops with exit `2` rather than silently
test the old file:

```text
error: 1 defender/target file has uncommitted changes (test/billing.test.mjs); worktree mode probes HEAD (bee6ee9), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.
```

### Commit, probe, freeze a baseline

```bash
git commit -am "test: an empty order is refused"
npx testguard-cli probe         # 1 faults probed: 1 killed. — exit 0
npx testguard-cli baseline      # freeze today's unproven findings
```

```text
baseline: 0 unproven findings frozen at 47209033778e → .testguard/baseline.json
Commit this file; from now on only new findings gate.
```

A baseline records every finding that is still unproven, so later probes fail
only on **new** ones. Here nothing is unproven, so it freezes zero; on a real
codebase the first baseline is how you adopt TestGuard without fixing every
survivor first. Commit `.testguard/baseline.json`; the rest of `.testguard/`
is regenerated and already ignored.

```bash
npx testguard-cli status        # state: clean — 1 claims / 1 faults; 1 killed; 0 new, 0 baselined
```

### Keep new code claimed

From here on, `gate` fails a change that adds source with no claim. Add an
unclaimed `src/shipping.mjs` and run the pre-commit form:

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # the working tree against HEAD
```

```text
gate: 1 file changed since HEAD (merge-base a847223) in the working tree; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/shipping.mjs  (source, nearest claim BILLING-EMPTY-ORDER)
           → testguard scaffold src/shipping.mjs --claim BILLING-EMPTY-ORDER
Next: state the claim for each UNCLAIMED file (scaffold proposes the faults), or add a testguard.ignore.json path entry with a reason that a reviewer will accept.
```

One unclaimed file exits `1`. In a pull request the same command runs as
`gate --changed origin/main`.

## What you committed

| File | Why it is committed |
|---|---|
| `testguard.claims.json` | the claims and their faults; it is code, review it like code |
| `.testguard/baseline.json` | the frozen contract: what was already unproven when you adopted |
| `.claude/skills/testguard/SKILL.md`, `.claude/settings.json`, `AGENTS.md` | the agent layer from `init` |
| `.gitignore` | the regenerated `.testguard/` files `init` ignores |

## Next

- [Writing claims](guides/writing-claims.md): what makes a claim worth defending, and where the intent comes from
- [Adopting TestGuard in an existing project](guides/existing-projects.md): the same loop on a real codebase, with a baseline
- [GitHub Actions](guides/ci/github-actions.md): the gate on every pull request, the probe on main
- [Verdicts](reference/verdicts.md): every verdict and the one fix for it
