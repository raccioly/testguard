# Test Specification

<!-- docguard:version 1.0.0 -->
<!-- docguard:status approved -->
<!-- docguard:last-reviewed 2026-09-18 -->
<!-- docguard:owner @raccioly -->

> Canonical. Code that contradicts this document is drift.

This project is a tool that measures test quality, so its own tests are held to
the standard it sells. The governing rule: **a test that would pass with the
behaviour broken is not a test.** Every claim in `testguard.claims.json` names
the test that defends it, and CI fails if any injected fault survives.

## Test Categories

| Category | Location | What it proves | Runtime |
|---|---|---|---|
| Unit | `test/*.test.mjs` | One pure function's branches, without a runner | milliseconds |
| Conformance | `spec/conformance/` | Every valid example validates; every must-reject document is rejected for the defect its filename names | ~1 s |
| Fixture acceptance | `test/probe.fixture.test.mjs`, `test/probe.jest.test.mjs`, `test/probe.playwright.test.mjs` | The whole pipeline reproduces a known-answer oracle, one per runner | 10–50 s each |
| Self-verification | `testguard.claims.json`, run by `npm run self:probe` | The tool's own invariants survive fault injection | ~25 min cold, seconds when verdicts are reused |
| Install smoke | `.github/scripts/install-smoke.mjs` | The **packed tarball** runs with production dependencies only | ~20 s |
| Runtime budget | `ci.yml` | The suite has not silently started walking the wrong tree | gate, not a test |

## Coverage Rules

Line coverage is **not** a gate in this project, deliberately: it cannot
distinguish a test that pins correct behaviour from one that pins a defect.
What is gated instead:

1. **Every claim must be killed.** `probe .` exits non-zero on any survivor and
   runs in both `ci.yml` and `release.yml`.
2. **Every changed source file must carry a claim** or an excusing `ignore`
   entry with a reason (`gate --changed`), on every pull request.
3. **A removed claim is a finding** (`claims --since`), because deleting a claim
   is cheaper than weakening its fault.
4. **Every spec change ships its conformance case** — schema, semantic rule,
   valid example and must-reject document, in the same pull request.
5. **A new fault shape needs a synthetic-file test and a README row.**

## Service-to-Test Map

| Module | Defending tests |
|---|---|
| `src/probe/classify.mjs` | `test/classify.test.mjs` |
| `src/probe/inject.mjs` | `test/inject.test.mjs` |
| `src/probe/probe.mjs` | `test/probe.fixture.test.mjs`, `test/probe-preconditions.test.mjs` |
| `src/probe/discover.mjs`, `src/probe/mocks.mjs` | `test/discover.test.mjs`, `test/mocks.test.mjs` |
| `src/probe/rank.mjs` | `test/rank-aliases.test.mjs`, `test/discover.test.mjs` |
| `src/probe/runners/` | `test/runner-vitest.test.mjs`, `test/runner-command.test.mjs`, `test/runner-playwright.test.mjs` |
| `src/probe/contention.mjs` | `test/contention.test.mjs` |
| `src/gate/changed.mjs` | `test/gate.test.mjs` |
| `src/baseline/baseline.mjs` | `test/baseline.test.mjs` |
| `src/status/status.mjs` | `test/status.test.mjs` |
| `src/brief/brief.mjs` | `test/brief.test.mjs` |
| `src/init/init.mjs` | `test/init.test.mjs` |
| `src/replay/` | `test/replay.test.mjs` |
| `src/mcp/` | `test/mcp.test.mjs` |
| `spec/lib/` | `spec/conformance/schemas.test.mjs` |

## Critical User Journeys (E2E Required)

Each is covered end to end through the real binary, not through an internal
function call.

| Journey | Covered by |
|---|---|
| Probe a project and reproduce every verdict in the closed set | the known-answer fixture, once per runner |
| Freeze a baseline, re-probe, and gate only the delta | `ci.yml` fixture chain: probe → baseline → probe → brief |
| A claim whose only importing test mocks the subject reports `NOCOVER` | fixture claim `EXPORT-002` |
| A browser-layer defender kills a fault a unit test cannot see | Playwright fixture `TOGGLE-001` vs `TOGGLE-002` |
| An unclaimed changed file fails the gate | `test/gate.test.mjs`, and this repository's own CI |
| The published package installs and runs | install smoke, plus a post-publish check against the registry |

## Canary Tests (Pre-Deploy Gates)

Run before any release is allowed to publish:

| Gate | Command | Failure means |
|---|---|---|
| Suite | `npm test` | do not ship |
| Self-probe | `testguard probe .` | an invariant of the tool is undefended; do not ship |
| Install smoke | `npm run test:install` | the package does not run as installed; do not ship |
| Version sync | `sync-release-version.mjs --check` | surfaces disagree about the version |
| Python wrapper | `import testguard_cli.wrapper` | the PyPI surface is broken |

## Recommended Test Patterns

- **Drive the real function.** Never re-implement the logic under test inside
  the test and assert against the copy; that is the exact failure a field report
  found in the wild — fifteen green tests, zero detection.
- **Do not mock the subject of a claim.** A test that mocks the target cannot
  detect a fault in it. TestGuard now excludes such tests from discovery and
  reports `mocked-never-asserted` when they never assert on what they mocked.
- **Assert on content, not shape.** `expect.objectContaining({...})` that omits
  the field carrying the data is the canonical blind spot; the known-answer
  fixture reproduces it in ten lines.
- **Verify a fixture expectation by hand before it becomes the oracle.** Apply
  the fault, run the defenders, record what happened. A fixture edited to match
  the tool's output proves nothing.
- **Prefer cheap defenders.** A claim's cost is set by the tests it names.
  Naming a 50-second acceptance test for a claim about a pure function makes
  every future release slower for no extra evidence.
