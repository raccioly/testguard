# Rules for every Jules routine on TestGuard

Read this before any routine file. `AGENTS.md` still applies in full; this
adds what a scheduled agent needs. The policy that enforces it on GitHub is
`.github/scripts/jules-policy.mjs`.

## 1. Preflight decides whether there is work

Run `node .jules/preflight.mjs <routine>` first. It prints `GO` with the one
target for this run, or `STOP: <reason>`.

- **STOP** means end the task now: no changes, no branch, no pull request.
  Report the reason in the task summary.
- **GO** means work on that target only, whatever else you notice. Mention
  anything else in the task summary instead.

## 2. No finding, no pull request

Open a pull request only for a change backed by evidence. If the routine finds
nothing, end the task with a one-paragraph summary. A pull request that changes
nothing, reports that something is up to date, or restates a count is closed on
arrival.

## 3. One pull request, titled by the preflight

- Use the title line preflight printed, replacing `<one-line summary>`. The
  `[jules:<routine>] <target>` prefix is how duplicates are detected; do not
  change it.
- Keep it to 10 files or fewer.
- The body has three sections:
  - **Evidence:** the exact commands you ran and their output, before and after.
  - **What changed:** what you changed.
  - **Dropped:** what you looked at and rejected, and why.

## 4. Before you open the pull request, run

```bash
npm test
node cli/testguard.mjs claims . --check-anchors
node cli/testguard.mjs gate . --changed origin/main
```

If you changed `testguard.claims.json`, also run this; every fault you added
must be killed:

```bash
node cli/testguard.mjs probe . --claim <ID> --include-dirty
```

## 5. If the suite is red before you change anything

That is your environment, not the code: CI on `main` is green. Do not fix it.
End the task and describe the failure in the summary.

## 6. Never

- edit `fixtures/**/expected.json`. Those are oracles, verified by hand.
- delete or weaken a test or an assertion, or edit an existing test file.
  Add a new test file instead.
- remove a claim or a fault. Do not change an existing claim's statement or
  an existing fault, and do not edit `testguard.ignore.json` or
  `.testguard/baseline.json`.
- add a dependency.
- add a network call or telemetry to `src/`.
- touch `.github/`, `.jules/`, `AGENTS.md`, `CLAUDE.md`, `package.json`,
  `package-lock.json`, `pyproject.toml`, `action.yml` or `packaging/`.
- commit scratch files such as `patch.diff` or `commit_message.txt`, or
  journals such as `.jules/*.md` notes.
- quote names, paths or text from any private codebase. Use neutral domains
  only.

## 7. What merges without a maintainer

Two kinds of change can merge on a green CI with no maintainer:

- user docs: `README.md`, `docs/**/*.md`.
- new test files, plus their names appended to the `defendedBy` of existing
  claims.

Everything else waits for review. That is expected, not a failure. At most
five Jules pull requests wait at once; past that, preflight answers STOP.
