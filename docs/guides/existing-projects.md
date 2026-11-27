# Adopting TestGuard in an existing project

This guide is for a team that has a working codebase and a green test suite.
The team wants to know what those tests actually defend, and does not want to
stop all work to write a claim for every file. You do not need to claim the
whole system before TestGuard is useful. Install it in place. Gate the **new**
changes from day one. Write the first few claims where a silent failure would
hurt most. Freeze everything else as a baseline, and pay it down over time.

Each step ends with a **Tell your agent** block. It is a sentence that you can
paste into Claude Code, Codex, Cursor or any other harness, so that the agent
runs that step for you. The steps work the same way whether a person or an
agent runs them.

## Before you start

| You need | Why |
|---|---|
| Node ≥ 20 and `git` | TestGuard is a Node CLI. It probes inside a scratch worktree. |
| A test suite that is green on your default branch | Every probe starts by confirming that the defenders pass N times on unmodified code. A red or flaky suite gives `FLAKY-DEFENDER`, not findings. |
| The test runner declared by the project | vitest, jest or Playwright in `package.json`, or a Python interpreter with pytest (stdlib `unittest` otherwise). Anything else goes through `--runner-cmd`. See [languages and runners](../reference/languages-and-runners.md). |
| Python ≥ 3.8 | Only when you probe Python code. |

## 1. Start from a reviewable baseline

Create a branch for the adoption. Then every file that TestGuard writes shows
up in an ordinary code review. Install TestGuard as a development dependency.
This pins the version that your CI and your session-start hook use. Then run
`init` from the repository root:

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
+ .gitignore: 12 lines added
```

`init` does not create a claims file, change your tests or touch source code.
If `AGENTS.md` or `.claude/settings.json` already exist, `init` adds its
section or its hook line and leaves the rest alone. Review the diff, then
commit it.

> **Tell your agent:** "Install testguard-cli as a dev dependency, run
> `npx testguard init`, show me the diff, and commit it on a new branch."

## 2. Ask where the project stands

```bash
npx testguard status
```

On a project with no claims, the answer is always `no-claims`. The useful part
is the **surface** line. It shows how much of the codebase carries a claim, and
which modules change most often.

```
state: no-claims — 0 claims / 0 faults
surface:  0 of 2 source modules carry a claim; 0 of 2 highest-churn modules claimed (last 1 commit)
UNCLAIMED src/export.mjs — 1 change in history window
UNCLAIMED src/redact.mjs — 1 change in history window
next:     [scaffold] testguard scaffold src/export.mjs
```

`status` lists the unclaimed modules by churn over the last 200 commits. A
regression is most likely to ship unnoticed in code that changes often and
carries no claim. So that list is your first shortlist.

`status --json` returns the same answer as one document with `state` and a
single `next` action. Agents read that document and nothing else. See
[AI agents](ai-agents.md).

> **Tell your agent:** "Run `testguard status --json` and summarize the
> surface line and the five highest-churn unclaimed modules."

## 3. Measure before you claim (recommended)

An existing project has something that a new project does not have:
**history**. Two commands use it to show you where the suite is blind, before
you write a single claim.

**Replay the bugs that already escaped.** For each fix commit that changed
source and a test together, `replay` reverts only the source and deletes the
test that the fix shipped. Then it asks whether the rest of the suite would
have noticed.

```bash
npx testguard replay --since HEAD~200..HEAD --max 20
```

A `blind` or `nocover` row is a real bug that your current suite would let
through again. `replay` reports and never gates. See [replay](replay.md) to
learn how to read its calibration table.

**Sweep the code that writes to storage.** Coverage cannot answer the
question "Does save actually save?":

```bash
npx testguard sweep --save-paths --cap 20
```

`sweep` proposes faults for every file that writes to storage. It probes a
bounded selection and reports which faults a green suite did not notice. It
never writes `testguard.claims.json`. Its output is only a list of candidates
for your first claims.

> **Tell your agent:** "Run `testguard replay --since HEAD~200..HEAD --max 20`
> and `testguard sweep --save-paths --cap 20`. Do not change any file. Report
> the blind and SURVIVED rows, grouped by module."

## 4. Gate new changes from today

This step stops the gap from growing, and it costs nothing in existing code.
`gate` fails a change whose source files carry no claim:

```bash
npx testguard gate --changed origin/main
```

```
gate: 1 file changed since main (merge-base 848e30b) in the HEAD bf0d824; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/export.mjs  (source)
           → testguard scaffold src/export.mjs
```

`gate` looks only at the **delta**. It does not evaluate files that nobody
touches. So a legacy codebase with zero claims passes the gate on every pull
request that leaves it alone. The gate fails only the pull requests that change
unclaimed code.

Three things make the gate easy to live with while you have few claims:

- **An empty claims file is valid.** Commit `{ "schemaVersion": 1, "claims": [] }`
  as `testguard.claims.json`. Then `probe --allow-empty` exits 0 and says that
  it verified nothing, instead of blocking a push. The default `probe` still
  exits 2 on zero claims, so this is an explicit choice.
- **Excuse, with a reason, what will never carry a claim.** Examples are
  generated code, thin wrappers whose logic lives elsewhere, and a module that
  you plan to delete. Add a `path` entry to `testguard.ignore.json`. The
  `reason` field is required. The gate prints every entry that it relied on. An
  entry past its `expires` date excuses nothing. See
  [configuration](../reference/configuration.md#ignore-file).
- **Wire it into CI with full history.** The gate needs the base commit, so
  check out with `fetch-depth: 0`. The ready-made jobs are in
  [GitHub Actions](ci/github-actions.md), [GitLab CI](ci/gitlab.md) and
  [pre-commit](ci/pre-commit.md).

Do not start with a broad ignore such as `src/**`. A gate that excuses
everything reports nothing, and the reviewer who reads the printed list of
entries will see it.

> **Tell your agent:** "Add an empty `testguard.claims.json`, add the TestGuard
> gate to CI following docs/guides/ci/github-actions.md with
> `fetch-depth: 0`, and propose `testguard.ignore.json` entries only for
> generated code, each with a reason."

## 5. Write the first claims where a silent failure hurts

Pick **three to five** behaviors whose silent failure would be an incident.
Examples are an authorization check, a payment amount, and a field that must
never reach a log or an export. Do not try to claim the whole system. Use the
shortlist from steps 2 and 3.

For each behavior, have `scaffold` propose the faults mechanically. Here it
reads the redaction module of the
[known-answer fixture](../../fixtures/known-answer/README.md):

```bash
npx testguard scaffold src/redact.mjs
```

```
11 proposed faults in 5 draft claims for src/redact.mjs — 3 statement-deleted, 5 field-dropped, 2 argument-swapped, 1 condition-forced
defendedBy prefilled from imports: test/redact.test.mjs
draft: .testguard/scaffold-redact.json
```

The draft goes to `.testguard/`, never to your claims file. Each proposal has a
`TODO:` statement, because a tool cannot know what the code is *supposed* to
do. Supply that statement from a source that is independent of the code (a
requirement, an ADR, a bug report or an incident). Keep the faults that express
it and drop the rest. Then move the claim into `testguard.claims.json`. Record
where the intent came from in the `source` of the claim. If you have no such
source, keep it `inferred`. [Writing claims](writing-claims.md) explains what
makes a claim worth keeping.

Then probe just those claims:

```bash
npx testguard claims --check-anchors   # every fault anchor resolves, before anything runs
npx testguard probe --claim AUTH-ADMIN,BILLING-TOTAL --no-escalate
```

Expect survivors. A first probe on an established suite almost always finds
some. Each survivor is a sentence of this form: *"the project says X, and
nothing checks it."* That is the finding. It is not a failure of the adoption.

> **Tell your agent:** "For src/auth/require-admin.ts, run `testguard scaffold`.
> The intended behavior is: <paste the requirement or bug>. Keep only the
> faults that break that behavior, write the claim into
> testguard.claims.json with source kind `spec` and that reference, then run
> `testguard probe --claim <ID>`. Do not write tests yet."

## 6. Freeze a baseline

You will not fix every survivor this week, and you should not have to before
the gate is useful. `baseline` freezes today's unproven findings. From then on,
only **new** findings fail:

```bash
npx testguard probe                  # full confirmation (3 runs per verdict)
npx testguard baseline
git add testguard.claims.json .testguard/baseline.json
git commit -m "test: adopt TestGuard with baseline"
```

Commit `.testguard/baseline.json`. Do not commit `evidence.json` or
`brief.json`. `init` already ignored them. `baseline` refuses provisional
`--confirm 1` evidence, so the debt that you freeze is debt that TestGuard
measured.

From this point on, the session-start hook briefs every agent session with the
ranked blind spots before the agent writes code.

## 7. Pay the debt down

Each baselined survivor is a test that someone has to write. The loop is the
same for a person and an agent:

```bash
npx testguard status --json                          # next.target names the survivor
# write a test that fails with the fault applied and passes on HEAD
npx testguard admit test/auth.test.ts --claim AUTH-ADMIN   # ADMITTED or NOT ADMITTED
```

`admit` runs the faults of the claim against your uncommitted test. It answers
`ADMITTED` only when the test is green on HEAD and fails on every fault, three
runs out of three. Commit the test and probe again. Run `baseline` again when
`status` says so.

Never make a survivor go away by editing its fault. The evidence records the
content hash of every fault, and `status` lists any fault that someone changed
after it survived. See [verdicts](../reference/verdicts.md) for the one
acceptable fix per verdict.

> **Tell your agent:** "Take the top `next.target` from `testguard status
> --json`. Write a test that fails with that fault applied and passes on HEAD.
> Prove it with `testguard admit`. Do not edit testguard.claims.json."

## 8. Scale out

When the first claims are steady:

- **Name kinds of promise, not single promises.** A *concern* such as "every
  admin route refuses a caller without the admin role", plus a glob, aims
  `sweep` at a whole area. See [writing claims](writing-claims.md#concerns).
- **Run `sweep --changed` in CI** on pull requests. An unclaimed change then
  gets candidate faults, not only an `UNCLAIMED` line.
- **Monorepos:** a nested `testguard.claims.json` is a separate project with its
  own gate. See [monorepo](monorepo.md).
- **Slow gates:** a shared, slow defender multiplies the cost. `probe --cost`
  shows where the time went. See [performance](performance.md).

## Decision points

| Situation | Do this |
|---|---|
| The suite is not green on main | Fix that first. TestGuard reports `FLAKY-DEFENDER` until the suite is green. |
| The suite takes many minutes | Start with `--claim` and `--no-escalate`. See [performance](performance.md). |
| You run something other than vitest, jest, Playwright, pytest or unittest | `--runner-cmd "<cmd> {files} … {out}"`. See [languages and runners](../reference/languages-and-runners.md). |
| `probe` refuses because tests are uncommitted | This is expected: worktree mode probes a commit. Use `--include-dirty` to probe the working tree. |
| A survivor is not worth a test | Narrow or drop the claim, and say why in the commit. TestGuard records the change and never hides it. |
| A whole directory will never carry claims | Add a `path` entry in `testguard.ignore.json` with a reason and, where possible, `expires`. |
| CI already probes and your laptop does not | Brief from the evidence of CI: `testguard brief --text --evidence <file>`. See [GitHub Actions](ci/github-actions.md). |

## What adoption does not do

- It does not generate tests. It judges the tests that you or your agent write.
- It does not write specifications for the existing system after the fact. You
  add claims where they are worth the effort, and the gate makes sure that new
  code arrives with claims.
- It does not send anything anywhere. The CLI makes no network calls and
  collects no telemetry.

If the first run fails before it reaches a verdict, see
[troubleshooting](../troubleshooting.md).

## Next

- [Writing claims](writing-claims.md): what makes a claim worth defending
- [GitHub Actions](ci/github-actions.md): the gate and the probe in CI
- [AI agents](ai-agents.md): the operating loop your agent follows
- [Verdicts](../reference/verdicts.md): what each result means and the one fix for it
