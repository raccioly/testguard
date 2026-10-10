# Languages and runners

Does TestGuard support your stack? This page is the answer: which languages it
reads, which test runners it drives, how it finds and picks them, and where the
support stops. It is for anyone evaluating TestGuard and for anyone whose probe
just refused with "test runner is not resolvable".

## The matrix

| | JavaScript | TypeScript | JSX / TSX (UI) | Python |
|---|---|---|---|---|
| Runners | `vitest`, `jest`, `playwright`, `node-test`, custom `--runner-cmd` | `vitest`, `jest`, `playwright`, custom `--runner-cmd` | `vitest`, `jest`, `playwright` | `python` (`pytest` or `unittest`) |
| Picked by `auto` | `vitest`, then `jest` | `vitest`, then `jest` | `vitest`, then `jest` | `python`, when no JavaScript runner sees a test; a `.py` defender always runs under Python |
| How the code is loaded | the runner's own loader | the runner's own transform: Vitest compiles TypeScript itself; Jest uses the transform the project already configures. TestGuard adds none | the runner's transform, as for TypeScript | the project's interpreter |
| Defender discovery | test files that import the fault's file: relative paths, `tsconfig`/`jsconfig` `paths` (through `extends` and `references`), vite/vitest `resolve.alias`, `package.json#imports`, re-exports through barrel files | as JavaScript; a `./x.js` specifier also resolves to `x.ts`/`x.tsx` (`.mjs` → `.mts`, `.cjs` → `.cts`) | as TypeScript | test files that import the fault's module by dotted module name, however it reached `sys.path` |
| Mock awareness | `vi.mock` / `jest.mock` (and `doMock`, `unstable_mockModule`) of the target removes the file as a defender | as JavaScript | as JavaScript | only a `patch()` of the whole module removes a defender; an attribute patch keeps it and raises `target-attribute-patched` |
| Scaffold producers | the seven shared shapes; the two JSX shapes only where a line is JSX | as JavaScript | all nine: the seven shared shapes plus `element-removed` and `handler-dropped` | the seven shared shapes, in Python syntax |
| `claims --check-anchors` | anchor located and replacement parsed (`.js`, `.mjs`, `.cjs`) | anchor located; replacement not parsed (a broken one surfaces at probe time as `fault-invalid`) | anchor located; replacement not parsed | anchor located and replacement parsed by the project's interpreter |
| `gate` counts it as source | `.js` `.mjs` `.cjs` | `.ts` `.mts` `.cts` | `.jsx` `.tsx` | `.py` |
| Minimum | Node ≥ 20 | Node ≥ 20 | Node ≥ 20 | Node ≥ 20 and Python ≥ 3.8; pytest 7, 8 or 9 when pytest is used |

The seven shared scaffold shapes are `condition-forced`, `statement-deleted`,
`return-altered`, `literal-changed`, `call-removed`, `field-dropped` and
`argument-swapped`. The two JSX shapes are proposed for any one-line JSX
element or `on<Event>={…}` prop the scaffold finds, whatever the file
extension; they have no Python meaning and are absent there. [Writing claims](../guides/writing-claims.md) describes every shape;
[Python](../guides/python.md) covers the Python differences.

### Runner summary

| `--runner` | Chosen when | Resolved from | Test universe comes from | `--workers N` | `--serial` | Proven by |
|---|---|---|---|---|---|---|
| `vitest` | first in `auto`, or explicit | the project's `vitest` package, then `vitest` on PATH | `vitest list --filesOnly` | `--maxWorkers=N` | `--maxWorkers=1 --no-file-parallelism` | [`fixtures/known-answer`](../../fixtures/known-answer/README.md) |
| `jest` | second in `auto`, or explicit; needs a `package.json` or `jest.config.*` | the project's `jest` package, then `jest` on PATH | `jest --listTests --json` | `--maxWorkers=N` | `--runInBand` | [`fixtures/known-answer-jest`](../../fixtures/known-answer-jest/README.md) |
| `playwright` | per file, for tests under the config's `testDir`; whole project only when explicit | the project's `@playwright/test` package | `playwright test --list` | `--workers=N` | `--workers=1` | [`fixtures/known-answer-playwright`](../../fixtures/known-answer-playwright/README.md) |
| `node-test` | explicit only | the Node executable running TestGuard | Node's own default collection | test concurrency `N` | concurrency 1 | [`fixtures/known-answer-node`](../../fixtures/known-answer-node/README.md) |
| `python` | third in `auto`, per file for every `.py` defender, or explicit | `--python`, `TESTGUARD_PYTHON`, the active virtualenv, the project's `.venv`/`venv`/`.env`, then PATH | the globs `test_*.py`, `test*.py`, `*_test.py` | always serial | always serial | [`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md) |
| `pytest` | explicit; `python` with the engine pinned | as `python` | as `python` | always serial | always serial | the same fixture, pytest leg |
| `unittest` | explicit; `python` with the engine pinned | as `python` | as `python` | always serial | always serial | the same fixture, stdlib leg |
| `auto` | the default | the first of `vitest`, `jest`, `python` that resolves **and** discovers at least one test file | — | — | — | — |

`--workers` defaults to `1`, which already means one file at a time, so
`--serial` only changes anything when it overrides a `--workers` above 1.
[Performance](../guides/performance.md) explains when to raise it.

## How a runner is chosen

`auto` tries `vitest`, then `jest`, then `python`, and takes the first one that
both resolves and lists a non-empty test universe. A runner that resolves but
sees no test file is skipped: a pure TypeScript project using only Playwright
resolves neither Vitest nor Jest, and without that rule `auto` would fall
through to Python — which resolves wherever a `python3` exists — find no `.py`
test, and report every claim `NOCOVER`. An explicit `--runner` with an empty
universe is refused for the same reason: zero observations are not evidence.

`auto` never picks `playwright` or `node-test` as the project runner.
Playwright needs a config to mean anything and owns its files anyway; the Node
built-in runner is opt-in.

Two runners own **files** rather than projects, whatever the project runner is:

- a test under the Playwright config's `testDir` runs under `playwright`;
- a `.py` test runs under `python`.

That is what lets one claim list a Vitest unit test, a Playwright spec and a
pytest test together. The record's `defenders.byRunner` says which file ran
where, and the evidence lists every runner that ran under `run.runners`. When
two owning runners both list the same file, the probe refuses rather than
guess.

## How a runner is resolved

A JavaScript runner is resolved from the **project's own package** first: the
version it pinned, and the package's own `bin` script, run with the Node that
runs TestGuard. Resolution walks up from the project directory the way Node's
`require` does, so a runner hoisted to a monorepo root is found. Only when no
package resolves is an executable on PATH asked for `--version`.

`npx` is never asked. Its cache answers `npx --no-install vitest --version`
from a project that has no Vitest at all, and a same-named executable (a
Python `playwright` shim, say) answers too — the run would then happen against
nothing.

`playwright` is stricter: it needs both a `playwright.config.{ts,mts,js,mjs,cjs}`
in the project directory and `@playwright/test` resolvable from it.

The evidence schema defines `runner.source` as `project`, `path` or `builtin`.
In 0.18.3 the probe writes it only for `node-test`:

```json
"runner": { "name": "node-test", "version": "24.18.0", "source": "builtin" }
```

A Python run records the engine that actually ran, never the adapter name:

```json
"runner": { "name": "unittest", "version": "CPython 3.12.13" }
```

An unresolvable runner is a precondition failure (exit `2`), never a verdict
about the tests.

## `vitest`

**When it is chosen.** First in `auto`, or `--runner vitest`.

**How files are discovered.** TestGuard asks Vitest itself:
`vitest list --filesOnly --passWithNoTests --maxWorkers=1`. Vitest loads its
own config and workspace, so the universe is exactly what `vitest run` would
collect. The config files it reads (`vitest.config.*`, `vite.config.*`,
`vitest.workspace.*`) are hashed into the evidence; editing one invalidates
reused verdicts.

**How it runs.** `vitest run <files> --reporter=json --outputFile=<tmp>
--maxWorkers=<N>`, plus `--no-file-parallelism` when only one worker is
allowed. The report is read from the file, never from stdout.

**Proof.** [`fixtures/known-answer`](../../fixtures/known-answer/README.md)
reproduces every verdict in its `expected.json` under Vitest.

## `jest`

**When it is chosen.** Second in `auto`, or `--runner jest`. It resolves only
when the project directory has a `package.json` or a
`jest.config.{js,mjs,cjs,ts,cts,json}`.

**How files are discovered.** `jest --listTests --json --runInBand`, so Jest's
own `testMatch`, `projects` and ignore patterns decide.

**How it runs.** `jest --ci --json --outputFile=<tmp> --runInBand
--runTestsByPath <files>`, or `--maxWorkers=<N>` instead of `--runInBand` when
`--workers` is above 1. `--runTestsByPath` makes each argument an exact path:
without it Jest reads positionals as regular expressions, and a path with `+`
or `(` silently matches nothing.

**Proof.** [`fixtures/known-answer-jest`](../../fixtures/known-answer-jest/README.md)
— the same claims in CommonJS, the same expected verdicts.

## `playwright`

**When it is chosen.** Per file: a `.spec.*` or `.test.*` file under the
config's `testDir` runs under Playwright whatever the project runner is.
`--runner playwright` makes it the project runner as well.

**How files are discovered.** `playwright test --list --reporter=json`.
Ownership reads `testDir` from the config as text — the config may be
TypeScript, so it is never imported — and only a string literal
(`testDir: './e2e'`) is understood. Without one, the config's own directory is
the test directory, as in Playwright.

**How it runs.** The project's `@playwright/test` CLI directly (no npm
subprocess per run): `playwright test --reporter=json --workers=<N> <files>`,
with the report written to a file named through
`PLAYWRIGHT_JSON_OUTPUT_FILE`.

**What counts.** A test Playwright marks `flaky` — failed, then passed on a
retry — makes the run **not** green; across N runs it becomes
`FLAKY-DEFENDER`. A `timedOut` test is a timeout and never a kill.

**Proof.** [`fixtures/known-answer-playwright`](../../fixtures/known-answer-playwright/README.md)
mixes Vitest and browserless Playwright defenders in one project.

## `node-test`

**When it is chosen.** Only with `--runner node-test`. `auto` keeps its order
and never selects it.

**Where it comes from.** The Node executable running TestGuard. Nothing is
installed; the evidence records `runner.source: "builtin"` and the actual Node
version.

**How files are discovered.** Node's own default collection — the files
`node --test` would run with no arguments. Discovery loads each test module
with every test body filtered out, so a module's top-level code does run
during discovery.

**How it runs.** Every confirmation uses fresh processes. `--workers` sets the
test concurrency. When exactly one test file is selected and Node is 22.8 or
later in the 22 line, 24 or 26, the file runs in one fresh process rather than
a controller plus a child.

**Limits.** Plain JavaScript with default Node loading. The runner refuses
when `NODE_OPTIONS` or `NODE_PATH` is set, and custom loaders and
module-mocking configurations are outside this adapter. It needs Node 20 or
newer; CI checks the floor against the fixture on Node 20.0.0.

**Proof.** [`fixtures/known-answer-node`](../../fixtures/known-answer-node/README.md).
To reproduce the narrow native-runner comparison, run this from a checkout of
this repository after installing its pinned development dependencies:

```bash
node .github/scripts/benchmark-node-runner.mjs --out /absolute/receipt-dir
```

It sends 17 identical classifier inputs and four existing faults through
complete probes with three confirmations, fresh worker receipts and reversed
execution order. The results describe that workload and runtime only.

## `python`, `pytest` and `unittest`

**When it is chosen.** Third in `auto`; for every `.py` defender whatever the
project runner is; or explicitly. `--runner python` takes pytest when the
interpreter can import it and stdlib `unittest` when it cannot.
`--runner pytest` and `--runner unittest` pin the engine and fail rather than
fall back, because which engine ran changes what the evidence means.

**Where it comes from.** The project's interpreter, resolved in this order:

1. `--python <path>` or `TESTGUARD_PYTHON` — when either is set it is the only
   candidate;
2. the active virtualenv (`$VIRTUAL_ENV`);
3. the project's `.venv`, `venv`, then `.env`;
4. `python3`, then `python`, on PATH.

It is resolved against your working tree, never the scratch worktree: a
virtualenv is gitignored, so the worktree does not contain one.

**How files are discovered.** The globs `test_*.py`, `test*.py` and
`*_test.py` across the project. pytest's `python_files` and `testpaths`
settings are not consulted. The universe is bound to the hashes of
`pyproject.toml`, `pytest.ini`, `setup.cfg`, `tox.ini` and `conftest.py`, so
editing one invalidates reused verdicts.

**How it runs.** Nothing is installed into the project; TestGuard's reporters
reach the interpreter through `PYTHONPATH`.

- pytest: `python -m pytest -p _testguard_pytest_plugin -p no:cacheprovider
  --maxfail=0 -q -p no:xdist <files>`. `--maxfail=0` overrides a `-x` in the
  project's `addopts`; the rest of `addopts` applies.
- unittest: `python -m _testguard_unittest_main <files>`.

Python always runs serially. A configuration that requires `pytest-xdist`
must still work without it; if it does not, the claim stays unproven rather
than bypassing the worker policy. Python has no per-test timeout without a
plugin, so a hang ends at `--budget`.

**Proof.** [`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md)
runs under both engines in CI, and both must reach the same sixteen verdicts.
The [Python guide](../guides/python.md) covers interpreters, `patch()`, import
provenance and the Python scaffold.

## Custom runners

Use `--runner-cmd` when the built-in command line is not how your project runs
its tests: a specific config, a workspace filter, a wrapper script. It is
accepted by `probe`, `admit`, `sweep` and `replay`.

```bash
npx testguard-cli probe . --runner-cmd "pnpm vitest run {files} --reporter=json --outputFile={out}"
```

### What the template must contain

| Requirement | Why |
|---|---|
| `{files}` as a word of its own | it expands to one argument per selected test file, relative to the probed directory |
| `{out}` somewhere | it is replaced by the path of a temporary report file; it may be embedded, as in `--outputFile={out}` |
| a report written to `{out}` in the jest-compatible JSON shape | the parser reads `testResults[]` (each with `status`, `message` and `assertionResults[]` carrying `status`, `fullName` or `title`, `failureMessages`) and the top-level `numTotalTests`, `numPassedTests`, `numFailedTests` and `success`. `vitest --reporter=json` and `jest --json` write it |

Single and double quotes group words. The command is **not** run through a
shell: no pipes, no `&&`, no `VAR=value` prefix, no glob expansion. Use
`env VAR=value <cmd>` or a script when you need any of those. The command runs
with the probed directory as its working directory — the scratch worktree,
unless `--in-place`.

A report without a `testResults` array makes the defenders unverifiable, and
the load message says the command must emit the jest-compatible shape.

### What changes with a custom command

- **One execution boundary.** Every selected defender, including Playwright
  and `.py` files, goes to your one command.
- **A static test universe.** The universe is the `--runner` adapter's file
  globs (Vitest's under `auto`) plus the Playwright- and Python-owned files,
  not a native listing. `--require-origin` cannot certify against it.
- **No worker flags.** `--workers` and `--serial` do not edit your command;
  put the runner's own parallelism flags in the template.
- **Reuse does not see the template.** Changing only the `--runner-cmd` text
  does not invalidate reused verdicts. Pass `--no-reuse` after you change it.

### Worked examples

A Vitest config other than the default:

```bash
npx testguard-cli probe . --runner-cmd "pnpm exec vitest run --config vitest.unit.config.ts {files} --reporter=json --outputFile={out}"
```

Jest with an explicit config, keeping exact-path matching:

```bash
npx testguard-cli probe . --runner-cmd "pnpm exec jest --config jest.unit.config.js --ci --json --outputFile={out} --runTestsByPath {files}"
```

A pnpm workspace, probing one package that is its own TestGuard project.
`pnpm --filter <package> exec` runs the command in that package's directory,
which is also the probed directory, so the relative `{files}` paths line up:

```bash
npx testguard-cli probe packages/billing --runner-cmd "pnpm --filter @acme/billing exec vitest run {files} --reporter=json --outputFile={out}"
```

Do not use a filter that moves the command into a different directory from
the one you probe: `{files}` are relative to the probed directory, and the
runner would look for them in the wrong place.
[Monorepos](../guides/monorepo.md) covers the layouts in full.

## Not supported yet

- **Languages other than JavaScript, TypeScript and Python.** Defender
  discovery, the scaffold, anchor syntax checks and `gate` cover only the
  extensions in the matrix above; `gate` excludes every other file as
  `non-source`.
- **Built-in runners beyond Vitest, Jest, Playwright, Node's test runner and
  Python.** Others go through `--runner-cmd` and need a reporter that writes
  the jest-compatible shape.
- **TypeScript, custom loaders, `NODE_OPTIONS` and module mocking under
  `node-test`.**
- **Parallel Python runs.** Python is serial; `pytest-xdist` is disabled.
- **Test generation.** The acceptance half exists (`admit`); writing the test
  stays the agent's job.
- **AST-aware producers.** The scaffold is deterministic line heuristics.
- **Transferring a calibration between repositories.** `replay` measures a
  calibration now; whether it carries to a repository with no history is
  unproven. See [Replay](../guides/replay.md).

## Next

- [Python](../guides/python.md) — probing a Python project end to end
- [Monorepos](../guides/monorepo.md) — nested projects, `--node-modules`, per-package CI
- [Performance](../guides/performance.md) — workers, budgets and why a gate gets slow
- [CLI reference](cli.md) — every flag on every command
