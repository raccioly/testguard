# Google Jules on TestGuard: maintainer setup

The routines live in this repository, so changing one is a reviewed pull
request rather than an edit in the Jules UI. Jules is told only "follow this
file".

| Path | What it is |
|---|---|
| `setup.sh` | Builds the environment snapshot. Fails unless the suite is green. |
| `RULES.md` | Rules every routine follows. |
| `routines/*.md` | One file per scheduled routine. |
| `preflight.mjs` | Step 0 of each routine. Picks this week's target, or answers STOP. |
| `../.github/scripts/jules-policy.mjs` | The policy behind preflight, triage and auto-merge. Unit-tested and claimed. |

## One-time configuration in the Jules UI

Open jules.google, select **raccioly/testguard** under Codebases, then set
the following.

**Configuration → Initial Setup**

- Enter `bash .jules/setup.sh`.
- Click **Run and Snapshot**. Re-snapshot after a dependency or Node change.

**Environment variables**

- None. Nothing in TestGuard or its tests needs a secret.

**Network access**

- **On.** Preflight reads the public GitHub API for the PR queue, and it
  fails closed: no network means every routine STOPs.

**Proactivity / Suggested Tasks**

- **Off** for this repository. Its suggestions bypass preflight.
- Do not start the built-in Performance, Design or Security templates. Their
  output is the Sentinel, Bolt and Palette flood DocGuard closed by the dozen.

**Knowledge (memory)**

- On. It keeps corrections you give Jules in a task.

**Global settings**

- **Reactive Mode on**, so Jules acts only on comments that tag `@Jules`.
  The triage bot never tags it.
- **Commit authoring: Jules.** Triage and auto-merge identify Jules PRs by the
  `google-labs-jules[bot]` author.
- When a task finishes, use **Publish PR**, not "Publish branch". A PR you
  open yourself is authored by you, and the policy treats it as a human's.

## The scheduled tasks

Create each one from the Task Input box: Planning → **Scheduled Task**,
branch `main`. Paste the prompt verbatim.

| Name | Frequency | Prompt |
|---|---|---|
| scaffold-hunt | Weekly, Monday | `Follow .jules/routines/scaffold-hunt.md exactly. Read .jules/RULES.md first. If preflight prints STOP, end the task with no changes and no pull request.` |
| runner-scout | Weekly, Wednesday | `Follow .jules/routines/runner-scout.md exactly. Read .jules/RULES.md first. If preflight prints STOP, end the task with no changes and no pull request.` |
| docs-drift | Weekly, Friday | `Follow .jules/routines/docs-drift.md exactly. Read .jules/RULES.md first. If preflight prints STOP, end the task with no changes and no pull request.` |

That is three tasks a week at most. On the free plan's 15 tasks a day the
quota is never the limit; the review queue is.

## What happens to a Jules PR

1. **Triage** (`jules-triage.yml`, when it opens) closes it if it is:
   - noise: an empty PR, a persona PR, a "nothing to change" report, a count
     sync, or a change only to `.jules/`;
   - the same work as an older open PR: the same `[jules:<routine>] <target>`,
     or the same files;
   - work declined within 60 days;
   - over the queue cap: five already waiting.

   Otherwise it labels the PR `jules-automerge-eligible` or `jules-review`.
2. **CI** runs the full matrix, including the `hermeticity` job.
3. **Auto-merge** (`auto-merge.yml`, after green CI) re-reads the exact head
   commit and merges only:
   - user docs;
   - new test files;
   - defenders for those new tests appended to existing claims, after
     comparing the claims file itself.

   Everything else is labelled `jules-review` and waits for you.

## Turning it down

- To pause a routine, use the task's menu in Jules.
- To reject a PR, close it unmerged. Its target is not proposed again for
  60 days.
- To retire a routine, delete the Jules task. Remove its file and its entry in
  `ROUTINES` in a pull request.
