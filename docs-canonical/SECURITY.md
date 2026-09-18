# Security

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-18 -->
<!-- docguard:owner @raccioly -->

> Canonical. Code that contradicts this document is drift.

TestGuard is a local command-line tool. It has no server, no account and no
network calls at run time. Its security surface is therefore unusual: the risks
are **supply chain**, **code execution from a data file**, and **damage to the
user's working tree**. Each is addressed below.

## Authentication

**None, by design.** There is no service to authenticate to, no API key, no
license check and no telemetry endpoint. The CLI never opens a socket.

The only authenticated operation in the project is **publishing**, which
happens in CI, never on a developer machine:

| Registry | Mechanism | Long-lived secret |
|---|---|---|
| npm | OIDC Trusted Publishing | none |
| PyPI | OIDC Trusted Publishing (environment `pypi`) | none |
| GitHub releases | `GITHUB_TOKEN`, scoped to the run | none stored |

There are no tokens in this repository to rotate or leak.

## Authorization

There are no roles or permissions inside the tool; it acts as the user who runs
it. Authorization is delegated to the filesystem and to git. The relevant
guarantees are about **what the tool is allowed to touch**:

- Faults are applied in a **scratch git worktree** by default, never in the
  user's checkout. `--in-place` is explicit opt-in.
- In-place mode refuses to start when a fault target file has uncommitted
  changes, so a restore cannot destroy unsaved work.
- Every mutation registers a restore handler that also runs on `SIGINT`,
  `SIGTERM`, `SIGHUP`, `uncaughtException` and process exit.
- The tool never writes to a path outside the project directory except its own
  temporary files, and `repoPath` in the schema rejects absolute paths and
  parent traversal.

## Secrets Management

TestGuard neither reads nor stores secrets. It has no credential file, no
keychain access and no environment variable holding a secret.

Two consequences worth stating for reviewers:

- **Evidence documents may quote source lines.** A fault's `find` and `replace`
  are excerpts of your code, and they are written into `evidence.json`. Treat
  evidence with the same sensitivity as the source it describes; the default
  `.gitignore` written by `init` keeps it out of version control.
- **Claims files are reviewed as code, not as configuration** — see below.

## Security Rules

**1. A claims file is executable input. Review it as code.**
A fault's `replace` string is written into your source and then run by your test
runner. Anyone who can edit `testguard.claims.json` can execute code in the
context of a probe. Treat it exactly like a test file: code review, branch
protection, no unreviewed automation writing to it. `scaffold` therefore never
writes into the real claims file — it emits a draft a human must merge.

**2. One runtime dependency, exact-pinned.**
`ajv` at `8.20.0`, pinned without a range. Every other capability is Node's
standard library. Adding a dependency requires a discussion and a recorded
decision. `npm run test:install` packs the tarball, installs it with production
dependencies only, and runs it — because v0.1.0 shipped unrunnable with a fully
green suite after a runtime import was left in `devDependencies`.

**3. Nothing the tool runs may reach the network.**
The session-start hook resolves an installed binary and falls back to
`command -v`; no form of `npx` appears in it, because `npx --no-install` still
resolves the package from the registry before declining to install. Runners are
resolved from the project's own `node_modules` first; a binary on `PATH` is a
recorded fallback (`run.runner.source`), and `npx` is never consulted.

**4. Supply-chain posture is enforced in CI.**
OSV scanning on every pull request and on a schedule; all GitHub Actions pinned
by commit SHA, not by tag; Dependabot restricted to minor and patch with
auto-merge only when the exact run is green on every Node leg.

**5. Untrusted repositories.** Probing a repository executes that
repository's test suite. Run TestGuard against code you would already be willing
to run `npm test` on. This is a property of test execution, not of TestGuard,
but it is the single most important thing to understand before pointing the tool
at code you did not write.

**6. Reporting.** Vulnerability reports go to the process in `SECURITY.md` at
the repository root. This document describes the design; that file describes
the disclosure process.
