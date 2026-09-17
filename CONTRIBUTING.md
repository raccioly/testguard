# Contributing to TestGuard

Thanks for looking. This is a small, sharp tool with an unusual constraint:
**it must never emit a verdict it cannot defend.** Most of the rules below
follow from that.

## Setup

```bash
git clone https://github.com/raccioly/testguard && cd testguard
npm install
npm test               # ~15s: unit tests + probing the fixture end to end
npm run self:probe     # TestGuard's own claims, probed by TestGuard
npm run test:install   # pack → install with prod deps only → run; what 0.1.0 lacked
```

Node ≥ 20. Python ≥ 3.8 only if you touch `testguard_cli/`.

## Layout

| Path | What lives there |
|---|---|
| `spec/schemas/` | the six shared formats (JSON Schema 2020-12). **The contract.** |
| `spec/lib/` | the validator and the one fingerprint implementation |
| `spec/conformance/` | one valid example per kind; must-reject documents named for their defect |
| `src/probe/` | worktree isolation, injector, runner adapter, classifier, ranker, orchestrator |
| `src/claims/`, `src/baseline/`, `src/brief/` | the other three commands |
| `src/commands/`, `src/cli.mjs`, `cli/` | argument parsing and dispatch |
| `fixtures/known-answer/` | the oracle: a project with a known verdict for every value in the verdict set |
| `testguard.claims.json` | TestGuard's claims about itself, probed in CI |

## Rules that are not negotiable

1. **Every document the tool writes is validated against the spec first.**
   `writeSpecDoc` refuses non-conforming output. Do not bypass it.
2. **The verdict set is closed.** Adding a verdict is a spec change: update
   `common.schema.json`, `GATE-SEMANTICS.md`, the validator's semantic rules,
   the fixture (a claim whose fault yields the new verdict, with an
   independently verified expectation), and `classify.test.mjs`.
3. **`classify()` stays pure**, and the order of its checks is the spec.
4. **Only a test body rejecting the behaviour kills.** Never let a timeout, a
   load failure, or an exit code count as detection.
5. **N-run confirmation everywhere** — baseline, probe, and escalation
   attribution. A single run is never evidence.
6. **One runtime dependency** (`ajv`, exact-pinned). Adding another needs a
   very good reason and a discussion first. `npm run test:install` proves
   the package runs as installed with production dependencies only.
7. **No client-identifying material.** Fixtures and examples use neutral
   domains. Benchmarks against real codebases live outside this repository
   (`bench/README.md`).

## Changing the fixture

`fixtures/known-answer/expected.json` is the oracle for `probe`. If you change
the fixture, verify each new expectation *independently* — apply the fault by
hand and run the defenders — before updating `expected.json`. A fixture
edited to match the tool's output proves nothing.

## Adding a claim about TestGuard itself

`testguard.claims.json` at the root is probed in CI; every fault must be
`killed`. To add one: state the invariant, write the fault as a
`find`/`replace` against `src/`, name the test file that defends it, and run
`npm run self:probe`. If it survives, **write the test first** — that is the
two-gate rule applied to ourselves: the new test must pass on HEAD and fail
on the fault.

## Pull requests

- `npm test` and `npm run self:probe` green.
- `CHANGELOG.md` has an entry under `[Unreleased]` (Keep a Changelog).
- Commit messages: `type(scope): summary` — `feat`, `fix`, `spec`, `docs`,
  `test`, `chore`, `release`.
- One concern per PR. Spec changes and code changes may travel together when
  one requires the other; say so in the description.

## Releases

`package.json` is the single source of truth for the version;
`.github/scripts/sync-release-version.mjs` propagates it. A weekly workflow
opens a release PR; merging it tags and publishes to npm and PyPI via OIDC
Trusted Publishing. There are no tokens to rotate.

## Licence

MIT. By contributing you agree your contribution is licensed the same way.
