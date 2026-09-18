# Environment

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-18 -->
<!-- docguard:owner @raccioly -->
<!-- docguard:quality negation-load off — the environment is defined by absences: no required variables, no secrets, no network, no service. -->
<!-- docguard:quality passive-voice off — setup steps describe what is read and written, not who reads and writes it. -->

> Canonical. Code that contradicts this document is drift.

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | >= 20.0.0 | `node:util.parseArgs`; CI also proves 22 and 24 |
| git | any modern version | worktree isolation, diffs, snapshots, patch ids |
| A test runner in the probed project | vitest, jest, or Playwright | resolved from that project's own `node_modules` |
| Python | >= 3.8 | **only** to work on the PyPI wrapper in `testguard_cli/` |

TestGuard installs one runtime dependency (`ajv`). It needs no compiler, no
container, no service and no network access at run time.

## Environment Variables

None are required. All are optional overrides.

| Variable | Read by | Effect |
|---|---|---|
| `TESTGUARD_NODE_MODULES` | `probe` | `node_modules` to link into the scratch worktree; same as `--node-modules` |
| `TESTGUARD_CHANGED_REF` | `gate`, `status --changed` | The reference a change is measured against; overrides CI detection |
| `GITHUB_BASE_REF` | `gate` | GitHub Actions pull requests: the base branch |
| `CI_MERGE_REQUEST_DIFF_BASE_SHA` | `gate` | GitLab merge request pipelines: exact diff base, needs no fetch |
| `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | `gate` | GitLab fallback when the diff base sha is absent |
| `CI` | runners | Set to `1` for every child process so runners use non-interactive output |

The tool sets `PLAYWRIGHT_JSON_OUTPUT_FILE` and `FORCE_COLOR=0` on the
processes it spawns. It reads no secret, no token and no credential.

## Configuration Files

| File | Owner | Committed | Purpose |
|---|---|---|---|
| `testguard.claims.json` | you | yes | The claims and their faults |
| `testguard.ignore.json` | you | yes | Reviewable scoping, every entry with a reason |
| `.testguard/baseline.json` | tool, frozen by you | yes | The frozen debt contract |
| `.testguard/evidence.json`, `brief.json`, `gate.json` | tool | no | Regenerated per run |
| `.docguard.json`, `.docguardignore` | DocGuard | yes | Documentation contract for this repository |
| `playwright.config.*` | your project | yes | Read as text to find `testDir`; never imported |
| `tsconfig.json` / `vite.config.*` | your project | yes | Read for path aliases when discovering defenders |

## Setup Steps

```bash
# Work on TestGuard itself
git clone https://github.com/raccioly/testguard && cd testguard
npm install
npm test                 # unit + conformance + fixture acceptance
npm run self:probe       # TestGuard probes its own claims; must exit 0
npm run test:install     # pack → install with prod deps only → run

# The Playwright fixture carries its own dependencies, deliberately
npm ci --prefix fixtures/known-answer-playwright

# Use TestGuard in another project
npx testguard-cli init       # skill, session-start hook, AGENTS.md section, gitignore lines
npx testguard-cli status --json
```

Documentation is governed by DocGuard: `docguard guard` validates this
repository against `docs-canonical/`, and the pre-commit and pre-push hooks run
it automatically.
