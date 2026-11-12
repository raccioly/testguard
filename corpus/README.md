# The benchmark corpus

A standing instrument that answers, after any change to TestGuard: **are the
verdicts still right, and did it get faster?** (issue #258)

`fixtures/known-answer*` prove the tool's mechanics, but they were written to
produce their answers. The corpus is the opposite: small projects whose
claims were not written from the tests, whose tests were not written to the
claims, and whose answer keys were derived by hand without ever running
TestGuard.

```bash
npm run corpus -- --install                # once: each subject's pinned dependencies
npm run corpus                             # every subject, every mode
npm run corpus -- --subject js-jest-newsletter --mode reference
npm run corpus -- --tool-mutants           # every deliberately broken build must go red
npm run corpus -- --check-mutants          # every mutant patch still applies (also in npm test)
npm run corpus -- --json out.json --markdown out.md
npm run corpus -- --subject-dir <path> --key <expected.json> [--claims <claims.json>] [--config <subject.json>]
```

Python subjects run under `--python <interpreter>` or `TESTGUARD_PYTHON`, else
the subject's own `.venv` (created by `--install`). The corpus never runs
inside `npm test` and is excluded from the published package.

## Rules

1. **Independence.** Each subject is written in this order by separate
   authors, each shown only what is listed in its `PROVENANCE.md`: the spec
   (`SPEC.md`), the implementation (from the spec only), the claims (from the
   spec and the source, never the tests) and the tests (from the spec, the
   source and per-file quality instructions, never the claims or faults). The
   claim and test authors run at the same time, so neither output exists while
   the other is written. Their exact prompts are in `provenance/prompts/`.
2. **The key is derived by hand, never by TestGuard.** `node corpus/derive.mjs
   <subject>` applies each fault to a scratch copy, runs the defenders with the
   subject's own runner (three times unmodified, three times faulted; for a
   would-be survivor also the whole suite three times and one run with the
   target made unparseable), restores and records what it saw. A person writes
   the verdict and why in `provenance/judgments.json`; `node corpus/key.mjs`
   joins the two into `expected.json`. The derivation never imports `src/`.
3. **The key is frozen.** Changing it is its own reviewed commit that says
   which of {tool, claim, subject} was wrong. It is never changed in a commit
   that changes `src/`, and never to match TestGuard's output.
4. **A defect is filed, not fixed here.** When the corpus shows TestGuard is
   wrong, the defect gets a GitHub issue and a reviewed entry in
   `known-failures.json` naming the issue and the exact observation it
   excuses; a different observation is not excused. A `killed` where the key
   says anything else is **critical** and can never be a known failure.
5. **An empty comparison is a failure.** A subject whose dependencies are
   missing, a key that does not match its claims, or a mode that measured no
   fault makes the run fail, never pass.
6. **Neutral domains only.** Nothing from any private codebase.

## Layout

```
corpus/
  run.mjs                 the harness (npm run corpus)
  derive.mjs              the hand procedure behind every key (no TestGuard)
  key.mjs                 judgments + observations → expected.json (--check)
  assemble.mjs            author claims + defender rule → claims.json (--check)
  lib/                    subject.mjs, layout.mjs, tool.mjs, checks.mjs, modes.mjs, mutants.mjs, scorecard.mjs;
                          unittest_runner.py and vitest-errors-reporter.mjs (derive.mjs only)
  scorecard.schema.json   the scorecard document
  known-failures.json     reviewed, filed TestGuard defects the corpus exposes
  tool-mutants/           deliberately broken builds (*.patch + manifest.json)
  <subject>/
    SPEC.md  PROVENANCE.md  subject.json  claims.json  expected.json
    provenance/           prompts/, claims.author.json, defenders.json, judgments.json, derivation*.json
    the project itself (source, tests, pinned dependency manifest)
```

`subject.json` says how to run a subject: `runner`, `install`
(`npm`, `npm-workspace`, `python-venv`, `none`), `installExtra` (commands run
after the install, such as the Playwright browser), `python` (the interpreter
for a subject with no venv), `testFiles` (the whole-suite pattern for
derivation), `budgetMs` (the per-run budget the key assumes), `typecheck`,
`probeArgs`, `counters` (files the planted flaky tests write), `noise` (the
metamorphic edits) and, for a workspace, `workspaceLinks`. Layout keys, shared
by the derivation and the harness through `lib/layout.mjs` so a key and the run
it judges see the same tree:

- `variants`: one subject measured under several layouts, each listed as
  `name@variant` (`node-test-catalog3@npm`, `@pnpm`). The `layout` of a
  workspace is `npm` (root `node_modules/@scope/*` links) or `pnpm` (each
  package's own `node_modules/@scope/*` links), built from one npm install;
  pnpm never runs. One key serves every variant, and `key.mjs` refuses to build
  it unless each variant's derivation observed the same thing.
- `ignoredCopies`: `{from, to}` copies placed in every scratch repository as
  untracked, git-ignored build output (#272): a `build/lib` or `.build/vendor`
  holding a copy of a package. `untrackedSources` names source directories
  that exist only as such copies.
- `nodeModulesLayout: "linked-entries"`: each copy gets a real `node_modules`
  whose entries are symlinks into the subject's install, as a worktree whose
  install belongs to another checkout has (#279). Runner caches (`.vite`,
  `.vite-temp`, `.vitest-cache`) are never linked: vitest writes into them on
  every run, and through a link that write would land in the other checkout.

Every probe the harness runs, in every mode, refusals and exit-2 runs
included, also checks **subject-untouched** (`lib/untouched.mjs`): before and
after the probe it snapshots the repository the tool was pointed at
(`git status --porcelain --ignored`, a content hash of every tracked file, and
the names and link targets of every `node_modules` level), and any difference
is a **critical** failure the scorecard names as "tool modified the subject:
<path>". No known-failure entry can excuse it, and an empty snapshot is a
failure too. vite and vitest's own caches inside a real `node_modules`
directory are the only entries left out.

Every mode also checks **install-unchanged**: the subject's own install is
hashed (file bytes and link targets) before the subject's first mode and after
each one. For `linked-entries` the hash is byte for byte. Where a copy's
`node_modules` is a single link to the install, vite and vitest write their own
caches into it (`.vite`, `.vite-temp`, `.vitest-cache`) with no tool involved,
so those three entries are left out and everything else must be unchanged.

## Subjects

| Subject | Runner | Shape | Planted |
|---|---|---|---|
| `ts-vitest-stock` | vitest | strict TypeScript, tsconfig path alias, barrel file | thorough, partial, undeclared killer (escalation), a fault that parses but does not type-check, shared test helper (reuse edit) |
| `js-jest-newsletter` | jest | CommonJS | hollow test (exception-only kill and survivor), fault that never returns (timeout), declared defender that never imports its target, mocked module, no test at all |
| `py-pytest-circulation` | pytest | package layout | rotating test (inconsistent probe), alternating test (defenders not green), partial |
| `node-test-floorplan` | node:test | two-package npm workspace | hollow test, partial, a defender that reaches its target through the workspace link |
| `js-playwright-gallery` | Playwright | browser ES modules served through `page.route` (no port), plus node-side tests | hollow and partial browser tests, a fault the page hangs on (timeout), a browser module that does not parse (timeout, not fault-invalid: the runner reports no parse error), undeclared killers |
| `py-unittest-shipping` | unittest | stdlib only; an ignored `build/lib` holding copies of the package and of a vendored package with computed imports (#272) | hollow test (exception-only kill, undeclared killer), partial, `--changed` over a docs-only commit (selects nothing) and a one-test-file commit |
| `js-vitest-booking` | vitest | `src/format` is a symlink to `lib/format`; one fault is written through the link | a declared defender that cannot load (`defenders-failed-to-load`), a partial defender with undeclared killers |
| `ts-vitest-converter` | vitest | strict TypeScript; plugins loaded by a computed `import()`; `vi.mock` of a collaborator | a check helper that alternates `expect`/`throw` per run (the `mixed` kill kind), exception-only kills, a type-check-only fault, a reuse edit reachable only through the computed import (rule 8: never reused) |
| `node-test-catalog3` | node:test | three-package workspace in npm and pnpm layouts; tests reach `@shelf/core` through the link and through a relative path; an ignored `.build/vendor` copy of core (#272) | faults in core defended only by sibling packages' tests, partial, `--changed` over docs-only and one-file commits |
| `js-vitest-projects-habits` | vitest | `test.projects` with two projects and a file in both (#277, fixed by #280) | every fault keyed as derived by hand; partial with undeclared killers |
| `js-vitest-mergeconfig-ledger` | vitest | `vitest.config.js` built with `mergeConfig` from `vite` (#278, fixed by #280); `linked-entries` install (#279) | partial |

Every PR 1 subject also carries a fault that does not parse, a missing anchor
and an ambiguous anchor; the PR 2 subjects carry a fault that does not parse
where the runner can report one.

## Modes and checks

| Mode | What runs | Checked against |
|---|---|---|
| `reference` | serial (`--serial`), `--no-reuse`, fresh process, fresh repository | the key |
| `twice` | the same probe again in the same repository | key, reference |
| `reuse` | seed; unchanged; after the keyed edit to an imported file; after a simulated tool-version change | key (with the edit's overrides); unchanged run reuses something; the edit re-measures every fault that imports the file; the version change reuses nothing |
| `default` | no width flag and `TESTGUARD_FAULT_WORKERS` unset: the CLI's automatic width (#270) | key, reference (map and order), `run.faultWorkersSource: auto` with `run.cpus` |
| `workers-2`, `workers-4` | `--fault-workers 2` / `4` | key, reference (map and order) |
| `typecheck` | `--typecheck` (TypeScript subjects) | key with its type-check overrides, reference elsewhere |
| `changed` | `--changed HEAD~1` over scripted commits, then an unresolvable reference | keyed selections, key and reference for what is selected, exit 2 for the bad reference |
| `partial` | `--command-budget 1000 --partial-on-budget` | every fault named in order; budget exhausted and its counts agree; not-reached records empty; whatever was reached matches the key |
| `scratch` | `--scratch-dir` with node_modules a read-only copy (where the subject's own runner can run read-only; see `readOnlyNodeModules` in `subject.json`) | key, reference; node_modules unchanged; scratch directory left empty except the documented `testguard-locks/` |
| `assertion-kill` | `--require-assertion-kill` | key, reference; the policy names exactly the keyed exception-only kills |
| `reorder` | claims (and faults) in reverse order | key; same map; records follow the new order |
| `noise` | an unrelated file added and an untouched file renamed | key, reference |

A mode whose answers differ from the reference on the same commit is a
**differential** failure even when the key has no opinion, because the slow
mode is the oracle for the fast ones.

## Tool mutants

`tool-mutants/*.patch` are realistic regressions in `src/` (a timeout counted
as a kill, a mixed result counted as a kill, a fault not restored, reuse
ignoring the import closure or the tool version, the type check skipped, a
not-reached fault dropped, the fan-out sharing one tree, the negative control
skipped, a git failure read as an empty change, an exception-only kill
reported as an assertion, a baseline that need not be green, a mixed kill
kind read as assertion, a defender that cannot load read as flaky, vitest's
error classes dropped, a Playwright timeout read as a failure, unittest's
error channel read as an assertion, discovery writing into the project). `--tool-mutants`
applies each to a scratch copy of the tool and runs the subjects and modes its
manifest entry names, stopping at the first red check. The scorecard reports
N of M caught; a mutant nothing catches is a gap in the corpus. A mutant must be
caught by the key or a mode check, not only by TestGuard's own evidence
validator: when a broken build makes the tool refuse to write evidence, the
scorecard reports that run as **the tool wrote no evidence** (with the tool's
reason), never as wrong verdicts. The same regressions written at the verdict
function (`classify.mjs`: the timeout branch, the N/N agreement, the
`subjectReached` guard) are refused by that validator; the patches here break
the layers below it so the evidence stays valid and only the key can tell. Patches drift
with `src/`: `test/corpus-mutants.test.mjs` (part of `npm test`) fails as soon
as one no longer applies, and the change that moved the code regenerates it.

## Scorecard

One JSON document (`scorecard.schema.json`) and a Markdown table: per subject
and mode, faults right / wrong / critical / known, the differential result,
every mode check, runner invocations, raw seconds, seconds normalized by the
reference workload of `.github/scripts/measure-reference.mjs` (timed before
and after the run, divided by the `baselineMs` in `testguard.cost-budget.json`),
and each mode's speedup against the reference. CI publishes it as a job
summary, with the base branch's numbers beside it when the base has one.

## Known TestGuard defects the corpus found

| Issue | Subject | What |
|---|---|---|
| #263 | `node-test-floorplan` | A fault in a workspace package, defended by a sibling package's test through the `node_modules` link, reads `unverifiable`/`subject-not-executed`: the scratch worktree's link resolves to the original checkout. Known failure for `LSHAPE-ESTIMATE-USES-CORE-AREA/F1`, `/F2`. **Fixed by #276**; the subject now matches its key. |
| #264 | `ts-vitest-stock` | A vitest alias written `fileURLToPath(new URL('./src', import.meta.url))` makes `probe` refuse the whole project (exit 2). The subject uses the equivalent `join()` form so it measures everything else. **Fixed by #276**; the subject now matches its key. |
| #266 | `js-jest-newsletter` | `module.exports = { X: call() }` in `src/errors.js` makes every closure indeterminate: nothing is reused and `--changed` selects every claim (a safe superset). Known failure for the `footer-source` selection. **Fixed by #276**; the subject now matches its key. |
| #267 | `ts-vitest-stock` | `export interface` marks a module `unsupported-syntax`, so every closure is indeterminate: nothing is reused and `--changed` selects every claim (a safe superset). Known failure for the `adjustments-test` selection. **Fixed by #276**; the subject now matches its key. |
| #268 | `node-test-floorplan` | `--changed` after an edit to `packages/geometry/src/units.js` selects only the 4 geometry claims and misses the 4 planner claims that import it through `@floorplan/geometry`: an **unsound** selection (stale verdicts stand). Known failure for the `geometry-source` selection. **Fixed by #276**; the subject now matches its key. |
| #282 | `js-vitest-booking` | Escalation names no undeclared killer when an unrelated test file fails to load: three tests fail by assertion in every whole-suite run, but the run's outcome is `error`. Known for `RATES-AND-PEAK-WINDOW/F1`, `/F2`. |
| #265 | `js-jest-newsletter` | GATE-SEMANTICS does not order `nocover` against an invalid anchor; the tool says `nocover`, the key says `anchor-ambiguous`. Known failure for `SCHEDULE-VALIDATION/F1` until the spec settles it. |

## A project outside the repository

The private real-codebase benchmark (see `bench/README.md`) runs through the
same harness by path and produces the same scorecard:

```bash
npm run corpus -- --subject-dir /path/to/project --key ~/bench/project/expected.json \
  --claims ~/bench/project/claims.json --config ~/bench/project/subject.json --mode reference
```
