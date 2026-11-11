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
  lib/                    subject.mjs, tool.mjs, checks.mjs, modes.mjs, mutants.mjs, scorecard.mjs
  scorecard.schema.json   the scorecard document
  known-failures.json     reviewed, filed TestGuard defects the corpus exposes
  tool-mutants/           deliberately broken builds (*.patch + manifest.json)
  <subject>/
    SPEC.md  PROVENANCE.md  subject.json  claims.json  expected.json
    provenance/           prompts/, claims.author.json, defenders.json, judgments.json, derivation*.json
    the project itself (source, tests, pinned dependency manifest)
```

`subject.json` says how to run a subject: `runner`, `install`
(`npm`, `npm-workspace`, `python-venv`), `testFiles` (the whole-suite pattern
for derivation), `budgetMs` (the per-run budget the key assumes), `typecheck`,
`probeArgs`, `counters` (files the planted flaky tests write), `noise` (the
metamorphic edits) and, for a workspace, `workspaceLinks`.

## Subjects

| Subject | Runner | Shape | Planted |
|---|---|---|---|
| `ts-vitest-stock` | vitest | strict TypeScript, tsconfig path alias, barrel file | thorough, partial, undeclared killer (escalation), a fault that parses but does not type-check, shared test helper (reuse edit) |
| `js-jest-newsletter` | jest | CommonJS | hollow test (exception-only kill and survivor), fault that never returns (timeout), declared defender that never imports its target, mocked module, no test at all |
| `py-pytest-circulation` | pytest | package layout | rotating test (inconsistent probe), alternating test (defenders not green), partial |
| `node-test-floorplan` | node:test | two-package npm workspace | hollow test, partial, a defender that reaches its target through the workspace link |

Every subject also carries a fault that does not parse, a missing anchor and
an ambiguous anchor.

## Modes and checks

| Mode | What runs | Checked against |
|---|---|---|
| `reference` | serial, `--no-reuse`, fresh process, fresh repository | the key |
| `twice` | the same probe again in the same repository | key, reference |
| `reuse` | seed; unchanged; after the keyed edit to an imported file; after a simulated tool-version change | key (with the edit's overrides); unchanged run reuses something; the edit re-measures every fault that imports the file; the version change reuses nothing |
| `workers-2`, `workers-4` | `--fault-workers 2` / `4` | key, reference (map and order) |
| `typecheck` | `--typecheck` (TypeScript subjects) | key with its type-check overrides, reference elsewhere |
| `changed` | `--changed HEAD~1` over scripted commits, then an unresolvable reference | keyed selections, key and reference for what is selected, exit 2 for the bad reference |
| `partial` | `--command-budget 1000 --partial-on-budget` | every fault named in order; budget exhausted and its counts agree; not-reached records empty; whatever was reached matches the key |
| `scratch` | `--scratch-dir` with node_modules a read-only copy | key, reference; node_modules unchanged; scratch directory left empty |
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
reported as an assertion, a baseline that need not be green). `--tool-mutants`
applies each to a scratch copy of the tool and runs the subjects and modes its
manifest entry names, stopping at the first red check. The scorecard reports
N of M caught; a mutant nothing catches is a gap in the corpus. Patches drift
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
| #263 | `node-test-floorplan` | A fault in a workspace package, defended by a sibling package's test through the `node_modules` link, reads `unverifiable`/`subject-not-executed`: the scratch worktree's link resolves to the original checkout. Known failure for `LSHAPE-ESTIMATE-USES-CORE-AREA/F1`, `/F2`. |
| #264 | `ts-vitest-stock` | A vitest alias written `fileURLToPath(new URL('./src', import.meta.url))` makes `probe` refuse the whole project (exit 2). The subject uses the equivalent `join()` form so it measures everything else. |
| #265 | `js-jest-newsletter` | GATE-SEMANTICS does not order `nocover` against an invalid anchor; the tool says `nocover`, the key says `anchor-ambiguous`. Known failure for `SCHEDULE-VALIDATION/F1` until the spec settles it. |

## A project outside the repository

The private real-codebase benchmark (see `bench/README.md`) runs through the
same harness by path and produces the same scorecard:

```bash
npm run corpus -- --subject-dir /path/to/project --key ~/bench/project/expected.json \
  --claims ~/bench/project/claims.json --config ~/bench/project/subject.json --mode reference
```
