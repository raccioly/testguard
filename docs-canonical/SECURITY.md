# Security

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-19 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality negation-load off — a security posture is a list of things that must not happen: no runtime network, no CLI secrets, no registry tokens, no telemetry. Stating them positively would weaken them. -->
<!-- docguard:quality passive-voice off — threat and control statements name what is protected, not who protects it; the actor is the system throughout. -->

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
| Homebrew tap | SSH deploy key scoped to `raccioly/homebrew-tap` | `HOMEBREW_TAP_DEPLOY_KEY` |

npm and PyPI have no registry tokens to rotate or leak. Homebrew publishing
uses one stored credential: a dedicated Ed25519 deploy key whose public half
has write access only to `raccioly/homebrew-tap` and whose private half is the
`HOMEBREW_TAP_DEPLOY_KEY` Actions secret in this repository. It is not a
personal key and cannot access another repository. Rotate it by replacing both
the tap deploy key and the Actions secret.

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
- A restore that cannot write the original back is raised, with one exception:
  in worktree mode a target that no longer exists is already restored — the
  mutation only ever lived inside a scratch worktree — and is recorded on the
  record as `detail.restoreSkipped`. A permission failure is still raised in
  both modes, because it can mean a mutated file left on disk.
- The tool never writes to a path outside the project directory except its own
  temporary files, and `repoPath` in the schema rejects absolute paths and
  parent traversal.

## Secrets Management

The TestGuard CLI neither reads nor stores secrets. It has no credential file,
no keychain access and no environment variable holding a secret. The release
workflow is the deliberate exception: its Homebrew step receives the
tap-scoped deploy key only while it copies a registry-verified formula to the
distribution repository. npm and PyPI publishing remain OIDC-only.

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

**6. Declared write boundary.** TestGuard writes only where this list says, so
a confined caller (no network, read-only root, one writable workspace and one
temp directory, `node_modules` installed beforehand) can provision exactly
that and verify it.

| Path | Written by | Why |
|---|---|---|
| the scratch directory (`--scratch-dir`, `TESTGUARD_SCRATCH_DIR`, else the OS temp directory) | `probe`, `sweep`, `replay`, `admit` | scratch worktrees, the temporary git index, runner report and sidecar reporter files, one private temp and data directory per runner process, each removed when its run ends; and `testguard-locks/`, the worktree-allocation lock directory (kept, empty between runs) |
| the evidence path (`--out`, else `<dir>/.testguard/`; `replay` also writes its calibration beside its report) | every command that writes evidence | the result of the run |
| the repository's `.git` | `probe`, `sweep`, `replay`, `admit` | `worktrees/` metadata for each scratch worktree (removed with it), and loose objects when `--include-dirty` snapshots an unstaged tree |
| the working tree and `.testguard/` | `scaffold --into`, `claims --annotate --apply`, `init`, `baseline`, `--in-place` | commands whose job is to write the project; `probe --in-place` edits the fault target and restores it |

`--scratch-dir` must name a directory that exists and can be written; otherwise
the command exits 2 before it writes anything. It is never created on the
caller's behalf. Every other path is read-only to TestGuard.

**The linked `node_modules` is never written through.** The scratch worktree
gets a `node_modules` directory of its own whose entries link to the shared
install, so a tool that writes `node_modules/.vite-temp`, `.vite`, `.vitest` or
`.cache` writes into the scratch tree. Tool caches that live in the temp
directory (jest's haste map and transform cache, Playwright's transform cache)
follow the runner's `TMPDIR`, which TestGuard points into the scratch
directory. Python writes no bytecode (`PYTHONDONTWRITEBYTECODE`,
`PYTHONPYCACHEPREFIX`) and pytest runs with `-p no:cacheprovider`. The
dirty-tree test discovery runs in your own tree, whose `node_modules` cannot be
swapped; against a read-only install it asks vitest 4 and later for
`--configLoader runner`. The evidence records `run.writeBoundary` (a signal for
whether the install was writable, never a path).

**What this does not promise.** Tests under probe run the project's own code,
with your privileges, and are not sandboxed. The write boundary lists where
TestGuard and its built-in runners write; it does not stop a test from writing
elsewhere, reading your files or opening a socket. Known leaks it does not
close: vitest keeps an API token in the per-user data directory, which only
Linux redirects (`XDG_DATA_HOME`); macOS and Windows write it under the home
directory. `--in-place` writes the working tree by definition. Use a container
or VM for untrusted code, and give it a writable scratch directory.

**7. Reporting.** Vulnerability reports go to the process in `SECURITY.md` at
the repository root. This document describes the design; that file describes
the disclosure process.
