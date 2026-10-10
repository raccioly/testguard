# Monorepos

This guide is for a repository that holds more than one package: how
TestGuard decides where one project ends and the next begins, how to install
the agent layer once for several projects, how the scratch worktree finds a
workspace's dependencies, and how to run one CI leg per package.

## A claims file makes a project

A TestGuard project is a directory that contains a `testguard.claims.json`.
Each one is separate: its own claims, its own `.testguard/` evidence and
baseline, its own gate. Nothing is merged across projects.

```
.
├── testguard.claims.json          # the root project: src/, scripts/, …
├── src/
└── packages/
    ├── auth/
    │   └── testguard.claims.json  # a separate project
    └── billing/
        └── testguard.claims.json  # a separate project
```

Commands that take a `[dir]` argument act on the project in that directory:

```bash
npx testguard-cli probe packages/billing                            # evidence in packages/billing/.testguard/
npx testguard-cli gate packages/billing --changed origin/main       # measures only that project's files
npx testguard-cli status --json packages/billing
```

`scaffold` and `admit` take file arguments instead and treat the current
directory as the project, so run them from inside the package.

### What the parent does with a nested project

A parent project never evaluates files that belong to a nested one. `gate`
reports them as **delegated** and names the command that does evaluate them:

```
gate: 2 files changed since HEAD~1 (merge-base 648877c) in the HEAD 8cd63ee; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/root.mjs  (source)
           → testguard scaffold src/root.mjs
delegated  1 file(s) belong to the TestGuard project at packages/billing/; run testguard gate packages/billing --changed HEAD~1; child coverage has not been evaluated here
```

Delegated files neither pass nor fail the parent's gate. The line says
"child coverage has not been evaluated here" because that is the truth: run
the child's gate too, which the CI matrix below does. With `--strict`, a change
whose every file was excluded or delegated fails the parent's gate rather than
passing with a note.

The same boundary applies elsewhere: the `@claim` annotation scan behind
`claims` and `status` skips nested projects, and so does the module surface
`status` reports.

A nested claims file must be a regular file, not a symlink, and must be valid.
If it is not, the parent's `gate` stops with exit `2` instead of guessing
where the boundary is.

`init` does not create a claims file, so a directory becomes a separate
project only once you write its `testguard.claims.json`.

### One project per package, or one for the whole repository

| Layout | Choose it when | Trade-off |
|---|---|---|
| One project per package | each package owns its tests and its runner config | defender discovery stays inside the package; a test in another package that imports this one by package name is not discovered |
| One project at the root | a root runner config (a Vitest workspace, a Jest `projects` list) runs every package's tests | one claims file and one gate for everything; probes and baselines are not split by package |

Defender discovery resolves relative imports and configured aliases
(`tsconfig` `paths`, vite/vitest `resolve.alias`, `package.json#imports`). A
bare package name such as `@acme/billing` is not resolved, so a cross-package
defender has to be listed in the claim's `defendedBy`. See
[Languages and runners](../reference/languages-and-runners.md).

## `init` in a subdirectory

Agent sessions run at the git root, so `init` installs the agent layer there
— the skill, the session-start hook, the `AGENTS.md` section — and keeps the
project layer (the `.gitignore` lines) in the subdirectory:

```bash
npx testguard-cli init packages/billing
```

```
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text packages/billing (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ packages/billing/.gitignore: 10 lines added
```

A second project adds one hook entry and one `AGENTS.md` bullet; it never
duplicates the section or replaces the skill:

```bash
npx testguard-cli init packages/auth
```

```
+ .claude/settings.json: SessionStart hook → brief --text packages/auth (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md: TestGuard section now lists packages/auth
+ packages/auth/.gitignore: 10 lines added
= .claude/skills/testguard/SKILL.md exists (use --force to replace)
```

Each hook entry tries the package's own install, then the root's, then a
`testguard` on PATH, and ends in `true`, so it can never break a session or
reach the network:

```
packages/billing/node_modules/.bin/testguard brief --text packages/billing 2>/dev/null || node_modules/.bin/testguard brief --text packages/billing 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text packages/billing 2>/dev/null; } || true
```

The `AGENTS.md` section lists every project, so an agent knows which
`status --json <dir>` to run:

```markdown
- `packages/billing/`: claims in `packages/billing/testguard.claims.json`; run `testguard status --json packages/billing` and follow `next`.
- `packages/auth/`: claims in `packages/auth/testguard.claims.json`; run `testguard status --json packages/auth` and follow `next`.
```

Use `--here` when the subdirectory is its own agent root — a package that
agents open on its own — to keep the skill, hook and `AGENTS.md` in that
directory instead of the git root. [AI agents](ai-agents.md) covers the agent
layer itself.

## Dependencies in the scratch worktree

A probe applies faults in a scratch git worktree of the whole repository, and
a fresh worktree has no `node_modules`. TestGuard links the main tree's in:
every `node_modules` directory up to three levels below the git root
(`packages/billing/node_modules` is two), skipping hidden directories. A
symlinked `node_modules` is linked to its resolved target.

JavaScript runners resolve the way Node's `require` does, walking up from the
project directory, so a runner hoisted to the root `node_modules` is found
from a package.

When dependencies live somewhere else — deeper than three levels, under a
hidden directory, outside the repository — the probe stops:

```
test runner is not resolvable in the scratch worktree (…). If dependencies are missing, pass --node-modules <path>, or run with --in-place. Otherwise fix the discovery error above.
```

Name the directory, and TestGuard links it as the probed project's
`node_modules` in the worktree:

```bash
npx testguard-cli probe packages/billing --node-modules ../shared-deps/node_modules
TESTGUARD_NODE_MODULES=/abs/path/to/node_modules npx testguard-cli probe packages/billing
```

`--node-modules` is accepted by `probe`, `admit`, `sweep` and `replay`.
`--in-place` avoids the worktree altogether: it faults your working tree and
restores it, and needs the fault target files to be clean.

A Python virtualenv is not linked; the interpreter is resolved against your
working tree by absolute path. See [Python](python.md).

## Workspace runner commands

When a package's tests only run through the package manager — a filtered
command, a non-default config — give the command to `--runner-cmd`:

```bash
npx testguard-cli probe packages/billing --runner-cmd "pnpm --filter @acme/billing exec vitest run {files} --reporter=json --outputFile={out}"
```

`{files}` are relative to the probed directory, and `pnpm --filter <package>
exec` runs in that package's directory, so the two line up when the probed
directory is the filtered package. A filter that moves the command into a
different directory breaks the paths. [Languages and
runners](../reference/languages-and-runners.md#custom-runners)
lists every requirement of the template.

## Replay in a monorepo

`replay` scopes fix commits to the probed project. A commit that touched
several packages counts only for its files inside this one, and a commit with
no source-and-test pair inside the project is skipped rather than reported as
a revert that did not apply:

```bash
npx testguard-cli replay packages/billing --since origin/main~200..origin/main
```

See [Replay](replay.md).

## One CI leg per package

Run each project in its own matrix leg. Install the workspace once at the
root; the Action's `working-directory` is the project directory.

```yaml
name: testguard
on: [pull_request]

jobs:
  testguard:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false            # one package's survivor should not hide another's
      matrix:
        project: [., packages/auth, packages/billing]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # gate measures against the base branch
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci               # every workspace's dependencies, from the root
      - name: gate
        uses: raccioly/testguard@v0.18.3
        with:
          command: gate
          working-directory: ${{ matrix.project }}
      - name: probe
        uses: raccioly/testguard@v0.18.3
        with:
          command: probe
          working-directory: ${{ matrix.project }}
```

The root leg (`.`) gates the files outside every package and prints the
delegated lines; each package leg evaluates its own. `fail-fast: false` keeps
every leg's verdicts visible. [GitHub Actions](ci/github-actions.md) and
[GitLab CI](ci/gitlab.md) cover inputs, evidence artifacts and baselines.

## Next

- [Languages and runners](../reference/languages-and-runners.md) — runner resolution and `--runner-cmd`
- [GitHub Actions](ci/github-actions.md) — every Action input
- [Performance](performance.md) — keep each leg's probe inside its budget
- [AI agents](ai-agents.md) — the agent layer `init` installs
