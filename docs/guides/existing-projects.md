# Adopting TestGuard in an existing project

This guide is for a team with a working codebase and a green test suite that
wants to know what those tests actually defend, without stopping everything to
write a claim for every file. You do not need to claim the whole system before
TestGuard is useful. Install it in place, gate the **new** changes from day
one, write the first few claims where a silent failure would hurt most, and
freeze everything else as a baseline you pay down over time.

Each step ends with a **Tell your agent** block: a sentence you can paste into
Claude Code, Codex, Cursor or any other harness to have it run that step for
you. The steps work the same whether a person or an agent runs them.

## Before you start

| You need | Why |
|---|---|
| Node ≥ 20 and `git` | TestGuard is a Node CLI and probes inside a scratch git worktree. |
| A test suite that is green on your default branch | Every probe starts by confirming the defenders pass N times on unmodified code. A red or flaky suite yields `FLAKY-DEFENDER`, not findings. |
| The test runner declared by the project | vitest, jest or Playwright in `package.json`, or a Python interpreter with pytest (stdlib `unittest` otherwise). Anything else goes through `--runner-cmd`. See [languages and runners](../reference/languages-and-runners.md). |
| Python ≥ 3.8 | Only when you probe Python code. |

## 1. Start from a reviewable baseline

Create a branch for the adoption so every file TestGuard writes shows up in an
ordinary code review. Install it as a development dependency, which pins the
version your CI and your session-start hook will use, then run `init` from the
repository root:

```bash
git switch -c chore/adopt-testguard
npm i -D testguard-cli        # or pip / Homebrew — see ../installation.md
npx testguard init            # writes the agent layer at the git root
```

`init` writes four things and changes nothing else:

```
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ .gitignore: 10 lines added
```

It does not create a claims file, change your tests or touch source code. If
`AGENTS.md` or `.claude/settings.json` already exist, `init` adds its section
or its hook line and leaves the rest alone. Review the diff, then commit it.

> **Tell your agent:** "Install testguard-cli as a dev dependency, run
> `npx testguard init`, show me the diff, and commit it on a new branch."

## 2. Ask where the project stands

```bash
npx testguard status
```

On a project with no claims the answer is always `no-claims`, and the useful
part is the **surface** line: how much of the codebase carries a claim, and
which modules change most often.

```
state: no-claims — 0 claims / 0 faults
surface:  0 of 2 source modules carry a claim; 0 of 2 highest-churn modules claimed (last 1 commit)
UNCLAIMED src/export.mjs — 1 change in history window
UNCLAIMED src/redact.mjs — 1 change in history window
next:     [scaffold] testguard scaffold src/export.mjs
```

The unclaimed modules are listed by churn over the last 200 commits. Code that
changes often and carries no claim is where a regression is most likely to
ship unnoticed, so that list is your first shortlist.

`status --json` returns the same answer as one document with `state` and a
single `next` action. Agents read that and nothing else; see
[AI agents](ai-agents.md).

> **Tell your agent:** "Run `testguard status --json` and summarise the
> surface line and the five highest-churn unclaimed modules."

## 3. Measure before you claim (recommended)

An existing project has something a new one does not: **history**. Two
commands use it to show you where the suite is blind before you have written a
single claim.

**Replay the bugs that already escaped.** For each fix commit that changed
source and a test together, `replay` reverts only the source, deletes the test
the fix shipped, and asks whether the rest of the suite would have noticed.

```bash
npx testguard replay --since HEAD~200..HEAD --max 20
```

A `blind` or `nocover` row is a real bug your current suite would let through
again. `replay` reports and never gates. See [replay](replay.md) for reading
its calibration table.

**Sweep the code that writes to storage.** "Does save actually save?" is the
question coverage cannot answer:

```bash
npx testguard sweep --save-paths --cap 20
```

It proposes faults for every file that writes to storage, probes a bounded
selection, and reports which ones a green suite did not notice. It never
writes `testguard.claims.json`. Its output is a list of candidates for your
first claims, nothing more.

> **Tell your agent:** "Run `testguard replay --since HEAD~200..HEAD --max 20`
> and `testguard sweep --save-paths --cap 20`. Do not change any file. Report
> the blind and SURVIVED rows, grouped by module."

## 4. Gate new changes from today

This is the step that stops the gap from growing, and it costs nothing in
existing code. `gate` fails a change whose source files carry no claim:

```bash
npx testguard gate --changed origin/main
```

```
gate: 1 file changed since main (merge-base 848e30b) in the HEAD bf0d824; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/export.mjs  (source)
           → testguard scaffold src/export.mjs
```

It only looks at the **delta**. Files nobody touches are not evaluated, so a
legacy codebase with zero claims passes the gate on every pull request that
leaves it alone, and fails only the ones that change unclaimed code.

Three things make the gate livable while claims are still few:

- **An empty claims file is valid.** Commit `{ "schemaVersion": 1, "claims": [] }`
  as `testguard.claims.json`. `probe --allow-empty` then exits 0 and says it
  verified nothing, rather than blocking a push. The default `probe` still
  exits 2 on zero claims, so this is an explicit choice.
- **Excuse what will never carry a claim, with a reason.** Generated code,
  thin wrappers whose logic lives elsewhere, a module scheduled for deletion:
  add a `path` entry to `testguard.ignore.json`. The `reason` field is
  required, the gate prints every entry it relied on, and an entry past its
  `expires` date excuses nothing. See [configuration](../reference/configuration.md#ignore-file).
- **Wire it into CI with full history.** The gate needs the base commit, so
  check out with `fetch-depth: 0`. The ready-made jobs are in
  [GitHub Actions](ci/github-actions.md), [GitLab CI](ci/gitlab.md) and
  [pre-commit](ci/pre-commit.md).

Do not start with a broad ignore such as `src/**`. A gate that excuses
everything is a gate that reports nothing, and the reviewer reading the
printed reliance list will see it.

> **Tell your agent:** "Add an empty `testguard.claims.json`, add the TestGuard
> gate to CI following docs/guides/ci/github-actions.md with
> `fetch-depth: 0`, and propose `testguard.ignore.json` entries only for
> generated code, each with a reason."

## 5. Write the first claims where a silent failure hurts

Pick **three to five** behaviours whose silent failure would be an incident:
an authorization check, a payment amount, a field that must never reach a log
or an export. Do not try to claim the whole system. Use the shortlist from
steps 2 and 3.

For each one, have `scaffold` propose the faults mechanically. Here it reads
the redaction module of the [known-answer fixture](../../fixtures/known-answer/README.md):

```bash
npx testguard scaffold src/redact.mjs
```

```
11 proposed faults in 5 draft claims for src/redact.mjs — 3 statement-deleted, 5 field-dropped, 2 argument-swapped, 1 condition-forced
defendedBy prefilled from imports: test/redact.test.mjs
draft: .testguard/scaffold-redact.json
```

The draft lands in `.testguard/`, never in your claims file. Each proposal has
a `TODO:` statement because a tool cannot know what the code is *supposed* to
do. Supply that from a source independent of the code (a requirement, an ADR,
a bug report, an incident), keep the faults that express it, drop the rest,
and move the claim into `testguard.claims.json`. Record where the intent came
from in the claim's `source`; if you have no such source, keep it `inferred`.
[Writing claims](writing-claims.md) covers what makes a claim worth keeping.

Then probe just those claims:

```bash
npx testguard claims --check-anchors   # every fault anchor resolves, before anything runs
npx testguard probe --claim AUTH-ADMIN,BILLING-TOTAL --no-escalate
```

Expect survivors. A first probe on an established suite almost always finds
some, and each one is a sentence of the form *"the project says X, and
nothing checks it."* That is the finding, not a failure of the adoption.

> **Tell your agent:** "For src/auth/require-admin.ts, run `testguard scaffold`.
> The intended behaviour is: <paste the requirement or bug>. Keep only the
> faults that break that behaviour, write the claim into
> testguard.claims.json with source kind `spec` and that reference, then run
> `testguard probe --claim <ID>`. Do not write tests yet."

## 6. Freeze a baseline

You will not fix every survivor this week, and you should not have to before
the gate is useful. `baseline` freezes today's unproven findings so that from
now on only **new** ones fail:

```bash
npx testguard probe                  # full confirmation (3 runs per verdict)
npx testguard baseline
git add testguard.claims.json .testguard/baseline.json
git commit -m "test: adopt TestGuard with baseline"
```

Commit `.testguard/baseline.json`. Do not commit `evidence.json` or
`brief.json`; `init` already ignored them. `baseline` refuses provisional
`--confirm 1` evidence, so the debt you freeze is debt that was measured.

From this point on, the session-start hook briefs every agent session with the
ranked blind spots, before it writes code.

## 7. Pay the debt down

Each baselined survivor is a test someone has to write. The loop is the same
for a person and an agent:

```bash
npx testguard status --json                          # next.target names the survivor
# write a test that fails with the fault applied and passes on HEAD
npx testguard admit test/auth.test.ts --claim AUTH-ADMIN   # ADMITTED or NOT ADMITTED
```

`admit` runs the claim's faults against your uncommitted test and answers
`ADMITTED` only when the test is green on HEAD and fails on every fault, three
runs out of three. Commit the test, re-probe, and run `baseline` again when
`status` says so.

Never make a survivor go away by editing its fault. The evidence records every
fault's content hash and `status` lists any fault changed after it survived.
See [verdicts](../reference/verdicts.md) for the one acceptable fix per
verdict.

> **Tell your agent:** "Take the top `next.target` from `testguard status
> --json`. Write a test that fails with that fault applied and passes on HEAD.
> Prove it with `testguard admit`. Do not edit testguard.claims.json."

## 8. Scale out

Once the first claims are steady:

- **Name kinds of promise, not single ones.** A *concern* such as "every admin
  route refuses a caller without the admin role" plus a glob aims `sweep` at a
  whole area; see [writing claims](writing-claims.md#concerns).
- **Run `sweep --changed` in CI** on pull requests, so an unclaimed change gets
  candidate faults instead of only an `UNCLAIMED` line.
- **Monorepos:** a nested `testguard.claims.json` is a separate project with its
  own gate; see [monorepo](monorepo.md).
- **Slow gates:** a shared, slow defender multiplies cost. `probe --cost` shows
  where the time went; see [performance](performance.md).

## Decision points

| Situation | Do this |
|---|---|
| The suite is not green on main | Fix that first. TestGuard will report `FLAKY-DEFENDER` until it is. |
| The suite takes many minutes | Start with `--claim` and `--no-escalate`; see [performance](performance.md). |
| You run something other than vitest, jest, Playwright, pytest or unittest | `--runner-cmd "<cmd> {files} … {out}"`; see [languages and runners](../reference/languages-and-runners.md). |
| `probe` refuses because tests are uncommitted | Expected: worktree mode probes a commit. Use `--include-dirty` to probe the working tree. |
| A survivor is not worth a test | Narrow or drop the claim and say why in the commit. The change is recorded, never hidden. |
| A whole directory will never carry claims | A `path` entry in `testguard.ignore.json` with a reason and, where possible, `expires`. |
| CI already probes and your laptop does not | Brief from CI's evidence: `testguard brief --text --evidence <file>`; see [GitHub Actions](ci/github-actions.md). |

## What adoption does not do

- It does not generate tests. It judges the ones you or your agent write.
- It does not retro-specify the existing system. Claims are added where they
  earn their keep, and the gate makes sure new code arrives with them.
- It does not send anything anywhere. The CLI makes no network calls and
  collects no telemetry.

If the first run fails before it reaches a verdict, see
[troubleshooting](../troubleshooting.md).

## Next

- [Writing claims](writing-claims.md): what makes a claim worth defending
- [GitHub Actions](ci/github-actions.md): the gate and the probe in CI
- [AI agents](ai-agents.md): the operating loop your agent follows
- [Verdicts](../reference/verdicts.md): what each result means and the one fix for it
