# Contributing to TestGuard

Thanks for looking. TestGuard is a small, sharp tool with one unusual
constraint: **it must never emit a verdict it cannot defend.** Most of the
rules below follow from that constraint.

## Setup

```bash
git clone https://github.com/raccioly/testguard && cd testguard
npm install
npm test               # ~15s: unit tests + probing the fixture end to end
npm run self:probe     # TestGuard's own claims, probed by TestGuard
npm run test:install   # pack → install with prod deps only → run; what 0.1.0 lacked
```

You need Node ≥ 20. You need Python ≥ 3.8 only if you touch `testguard_cli/`.

## Layout

| Path | What lives there |
|---|---|
| `spec/schemas/` | the fourteen shared formats (JSON Schema 2020-12). **The contract.** |
| `spec/lib/` | the validator and the one fingerprint implementation |
| `spec/conformance/` | one valid example per kind; must-reject documents named for their defect |
| `src/probe/` | worktree isolation, injector, runner adapter, classifier, ranker, orchestrator |
| `src/claims/`, `src/baseline/`, `src/brief/`, `src/gate/` | the other commands: claims, baseline, brief, and the change gate |
| `src/commands/`, `src/cli.mjs`, `cli/` | argument parsing and dispatch |
| `fixtures/known-answer/` | the oracle: a project with a known verdict for every value in the verdict set |
| `testguard.claims.json` | TestGuard's claims about itself, probed in CI |
| `docs/` | user documentation; `test/docs.test.mjs` checks it against the code |
| `docs-canonical/` | design intent (architecture, requirements, security), validated by DocGuard |

## Rules that are not negotiable

1. **Validate every document the tool writes against the spec first.**
   `writeSpecDoc` refuses non-conforming output. Do not bypass it.
2. **The verdict set is closed.** Adding a verdict is a spec change. Update
   `common.schema.json`, `GATE-SEMANTICS.md`, the validator's semantic rules,
   the fixture (a claim whose fault yields the new verdict, with an
   independently verified expectation), and `classify.test.mjs`.
3. **`classify()` stays pure.** The order of its checks is the spec.
4. **Only a test body that rejects the behaviour kills.** Never count a
   timeout, a load failure, or an exit code as detection.
5. **Confirm with N runs everywhere:** baseline, probe, and escalation
   attribution. A single run is never evidence.
6. **Keep one runtime dependency** (`ajv`, exact-pinned). To add another, you
   need a very good reason and a discussion first. `npm run test:install`
   proves the package runs as installed with production dependencies only.
7. **No client-identifying material.** Fixtures and examples use neutral
   domains. Benchmarks against real codebases live outside this repository
   (`bench/README.md`).

## Changing the fixture

`fixtures/known-answer/expected.json` is the oracle for `probe`. If you change
the fixture, verify each new expectation *independently* before you update
`expected.json`. To do that, apply the fault by hand and run the defenders. A
fixture edited to match the tool's output proves nothing.

## Adding a claim about TestGuard itself

`testguard.claims.json` at the root is probed in CI. Every fault must be
`killed`. To add a claim:

1. State the invariant.
2. Write the fault as a `find`/`replace` against `src/`.
3. Name the test file that defends it.
4. Run `npm run self:probe`.

If the fault survives, **write the test first.** This is the two-gate rule
applied to ourselves: the new test must pass on HEAD and fail on the fault.

## Changing documentation

User documentation lives in [`docs/`](docs/README.md). The README is the
front page. Every fact has one home page, and other pages link to it instead
of repeating it.

- **Update the reference page in the same PR as a user-visible change.** A new
  command needs a `## <command>` section in `docs/reference/cli.md`. A new
  runner needs a row in `docs/reference/languages-and-runners.md`. A new
  verdict, status state, schema, Action input or GitLab input needs its own
  page entry. `test/docs.test.mjs` derives each of those sets from the code
  and fails when a page is missing a member. It also fails on a broken
  relative link or heading anchor.
- **Version pins** (`raccioly/testguard@vX.Y.Z`, the GitLab include URL, a
  pre-commit `rev:`) belong only in the pages listed as `DOC_SURFACES` in
  `.github/scripts/sync-release-version.mjs`. That script rewrites them on
  every release. A pin anywhere else fails `test/release-version.test.mjs`. A
  new pinned page also needs adding to `RELEASE_SURFACES` in
  `.github/workflows/auto-merge.yml`.
- **README links into `docs/` are absolute** (`https://github.com/raccioly/testguard/blob/main/docs/…`).
  npm and PyPI render the README without the `docs/` directory.
- **Show real output.** Run the command against a fixture and paste what it
  printed. Shorten it with `…` if needed. Never write output by hand.
- **Translations** live in `docs/i18n/<lang>/` and cover the README and the
  quickstart. Each translation opens with a banner that names the English page
  and the release it was translated from. It keeps the English heading
  structure. It copies every fenced code block byte for byte.
  `test/docs.test.mjs` checks all three. When you change a code block in the
  README or quickstart, change the translations' copy of it in the same PR.
  Prose may lag. Commands may not.
- **No session-start hook example may contain `npx`.** Copy what
  `hookCommand()` emits. `test/init.test.mjs` checks the README and the
  canonical security document for this.

## Pull requests

- `npm test` and `npm run self:probe` are green.
- `CHANGELOG.md` has an entry under `[Unreleased]` (Keep a Changelog).
- Commit messages use `type(scope): summary`. The types are `feat`, `fix`,
  `spec`, `docs`, `test`, `chore` and `release`.
- Keep one concern per PR. Spec changes and code changes may travel together
  when one requires the other. Say so in the description.

## Releases

`package.json` is the single source of truth for the version.
`.github/scripts/sync-release-version.mjs` propagates it. A weekly workflow
opens a release PR. Merging that PR tags the release and publishes to npm and
PyPI through OIDC Trusted Publishing. There are no npm or PyPI tokens to
rotate. Homebrew uses a dedicated SSH deploy key that can write only to
`raccioly/homebrew-tap`. The private half is stored as the
`HOMEBREW_TAP_DEPLOY_KEY` Actions secret.

The Homebrew formula's `sha256` is the one surface that nobody can know before
publishing. `release.yml` sets it after `npm publish`, from the registry
tarball (`sync-release-version.mjs --sha256`). It copies that verified formula
byte-for-byte to the live tap. It lands the source copy as a bot PR with
auto-merge armed. This repository's `main` is protected, so no job commits to
it directly.
`--check` (offline) refuses a placeholder hash. `--check --online` compares
against the tarball. On every hourly sweep, `--check --online` decides whether
the formula is still owed.

## Licence

MIT. By contributing, you agree that your contribution has the same license.
