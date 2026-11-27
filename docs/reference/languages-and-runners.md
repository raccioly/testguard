# Languages and runners

Does TestGuard support your stack? This page answers that question. It says
which languages TestGuard reads and which test runners it drives. It says how
TestGuard finds and picks a runner, and where the support stops. Read it if
you are evaluating TestGuard. Read it also if your probe just refused with
"test runner is not resolvable".

## The matrix

| | JavaScript | TypeScript | JSX / TSX (UI) | Python |
|---|---|---|---|---|
| Runners | `vitest`, `jest`, `playwright`, `node-test`, custom `--runner-cmd` | `vitest`, `jest`, `playwright`, custom `--runner-cmd` | `vitest`, `jest`, `playwright` | `python` (`pytest` or `unittest`) |
| Picked by `auto` | `vitest`, then `jest` | `vitest`, then `jest` | `vitest`, then `jest` | `python`, when no JavaScript runner sees a test; a `.py` defender always runs under Python |
| How the code is loaded | the runner's own loader | the runner's own transform. Vitest compiles TypeScript itself. Jest uses the transform the project already configures. TestGuard adds none | the runner's transform, as for TypeScript | the project's interpreter |
| Defender discovery | test files that import the fault's file: relative paths, `tsconfig`/`jsconfig` `paths` (through `extends` and `references`), vite/vitest `resolve.alias`, Jest `moduleNameMapper` (a literal object; under Jest, `--findRelatedTests` answers for what the text cannot), `package.json#imports`, re-exports through barrel files | as JavaScript; a `./x.js` specifier also resolves to `x.ts`/`x.tsx` (`.mjs` → `.mts`, `.cjs` → `.cts`) | as TypeScript | test files that import the fault's module by dotted module name, however it reached `sys.path` |
| Mock awareness | `vi.mock` / `jest.mock` (and `doMock`, `unstable_mockModule`) of the target removes the file as a defender | as JavaScript | as JavaScript | only a `patch()` of the whole module removes a defender; an attribute patch keeps it and raises `target-attribute-patched` |
| Scaffold producers | the seven shared shapes; the two JSX shapes only where a line is JSX | as JavaScript | all nine: the seven shared shapes plus `element-removed` and `handler-dropped` | the seven shared shapes, in Python syntax |
| `claims --check-anchors` | anchor located and replacement parsed (`.js`, `.mjs`, `.cjs`) | anchor located; replacement not parsed (a broken one surfaces at probe time as `fault-invalid`); with `--typecheck`, also type checked | anchor located; replacement not parsed; with `--typecheck`, also type checked | anchor located and replacement parsed by the project's interpreter |
| `gate` counts it as source | `.js` `.mjs` `.cjs` | `.ts` `.mts` `.cts` | `.jsx` `.tsx` | `.py` |
| Minimum | Node ≥ 20 | Node ≥ 20 | Node ≥ 20 | Node ≥ 20 and Python ≥ 3.8; pytest 7, 8 or 9 when pytest is used |

The seven shared scaffold shapes are `condition-forced`, `statement-deleted`,
`return-altered`, `literal-changed`, `call-removed`, `field-dropped` and
`argument-swapped`. The scaffold proposes the two JSX shapes for any one-line
JSX element or `on<Event>={…}` prop it finds, whatever the file extension. They
have no Python meaning, so Python files do not get them.
[Writing claims](../guides/writing-claims.md) describes every shape.
[Python](../guides/python.md) covers the Python differences.

### Java, Kotlin and Angular

Three runners reach stacks that the matrix above does not list. Each is named
with `--runner`, and `auto` never picks it.

| | Java | Kotlin | Angular (TypeScript) |
|---|---|---|---|
| Runners | `maven`, `gradle` | `maven`, `gradle` | `karma` |
| Counted as source by `gate` and `status` | `.java`, when a `pom.xml` or a Gradle build file is in the file's directory or above it | `.kt`, on the same rule | `.ts`, as for TypeScript |
| Test files | `src/test/java/**`: `*Test.java`, `*Tests.java`, `*TestCase.java`, `Test*.java` | `src/test/kotlin/**`: the same names with `.kt` | `**/*.spec.ts` |
| Scaffold producers | five Java shapes (below) | none: a `.kt` file is refused, out loud | the TypeScript shapes |
| Defender discovery | none: declare `defendedBy` | none: declare `defendedBy` | test files that import the fault's file, as for TypeScript |
| Reports read | JUnit XML | JUnit XML | JUnit XML |

Without a build file, a changed `.java` or `.kt` file is the same gap it was:
`gate` reports it as `unsupported-language`, never as non-source.

**These runners were not run against a real Maven, Gradle, Karma or Chrome.**
Their tests use fake `mvnw`, `gradlew` and `ng` scripts that write the report
files the real tools are documented to write. Run a probe on a small project
of your own and read the first result before you trust a large one. The parts
to confirm first are listed under each runner.

The Java scaffold shapes are `condition-forced` (an `if` forced to `false` and
to `true`), `statement-deleted` (a one-line guard removed, the null guard
being the common case) with `call-removed` (`requireNonNull`), `return-altered`
(a literal changed, or a boolean check made `true`), `literal-changed` (a
boolean literal flipped) and `argument-swapped`. A swapped argument is `null`,
never `undefined`, and only for a parameter of a reference type, because
`null` does not compile where an `int` is expected. Each proposal must still
compile. A line that cannot be changed safely gets no proposal.

### Runner summary

| `--runner` | Chosen when | Resolved from | Test universe comes from | `--workers N` | `--serial` | Proven by |
|---|---|---|---|---|---|---|
| `vitest` | first in `auto`, or explicit | the project's `vitest` package, then `vitest` on PATH | `vitest list --filesOnly` | `--maxWorkers=N` | `--maxWorkers=1 --no-file-parallelism` | [`fixtures/known-answer`](../../fixtures/known-answer/README.md) |
| `jest` | second in `auto`, or explicit; needs a `package.json` or `jest.config.*` | the project's `jest` package, then `jest` on PATH | `jest --listTests --json` | `--maxWorkers=N` | `--runInBand` | [`fixtures/known-answer-jest`](../../fixtures/known-answer-jest/README.md) |
| `playwright` | per file, for tests under the config's `testDir`; whole project only when explicit | the project's `@playwright/test` package | `playwright test --list` | `--workers=N` | `--workers=1` | [`fixtures/known-answer-playwright`](../../fixtures/known-answer-playwright/README.md) |
| `node-test` | explicit only | the Node executable running TestGuard | Node's own default collection | test concurrency `N` | concurrency 1 | [`fixtures/known-answer-node`](../../fixtures/known-answer-node/README.md) |
| `maven` | explicit only; `auto` never picks it | the project's `./mvnw`, then `mvn` on PATH | the Surefire default test names under `src/test/java` and `src/test/kotlin` | not used | not used | none yet: tested with a fake `mvn` |
| `gradle` | explicit only; `auto` never picks it | the project's `./gradlew`, then `gradle` on PATH | the same test names | not used | not used | none yet: tested with a fake `gradle` |
| `karma` | explicit only; `auto` never picks it | the project's `@angular/cli`, never PATH | `**/*.spec.ts` | not used | not used | none yet: tested with a fake `ng` |
| `python` | third in `auto`, per file for every `.py` defender, or explicit | `--python`, `TESTGUARD_PYTHON`, the active virtualenv, the project's `.venv`/`venv`/`.env`, then PATH | the globs `test_*.py`, `test*.py`, `*_test.py` | always serial | always serial | [`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md) |
| `pytest` | explicit; `python` with the engine pinned | as `python` | as `python` | always serial | always serial | the same fixture, pytest leg |
| `unittest` | explicit; `python` with the engine pinned | as `python` | as `python` | always serial | always serial | the same fixture, stdlib leg |
| `auto` | the default | the first of `vitest`, `jest`, `python` that resolves **and** discovers at least one test file | — | — | — | — |

`--workers` defaults to `1`, which already means one file at a time per run.
For `probe`, `--serial` also means one fault at a time (`--fault-workers 1`).
For other commands, it changes only a run that raised `--workers`.
[Performance](../guides/performance.md) explains when to raise it.

## How a runner is chosen

`auto` tries `vitest`, then `jest`, then `python`. It takes the first one that
both resolves and lists a non-empty test universe. `auto` skips a runner that
resolves but sees no test file. Here is why. Take a pure TypeScript project
that uses only Playwright. It resolves neither Vitest nor Jest. Without this
rule, `auto` would fall through to Python, which resolves wherever a `python3`
exists. It would find no `.py` test and report every claim `NOCOVER`. An
explicit `--runner` with an empty universe is refused for the same reason: zero
observations are not evidence.

`auto` never picks `playwright`, `node-test`, `maven`, `gradle` or `karma` as the
project runner. Playwright needs a config to mean anything, and it owns its
files anyway. The Node built-in runner is opt-in. A `pom.xml` says a project is
built with Maven, not that TestGuard may run its tests, so the build-system
runners are opt-in too. When `auto` finds nothing to run and the project says
it uses one of them, the refusal says so first and gives the flag. Take an
Angular project with Karma and no Vitest or Jest. The refusal reads "Karma was
found (angular.json has a karma test builder), but TestGuard does not choose it
on its own: run it with --runner karma …", and then lists what `auto` tried.
It does not tell you to install Vitest.

Two runners own **files** rather than projects, whatever the project runner is:

- a test under the Playwright config's `testDir` runs under `playwright`;
- a `.py` test runs under `python`.

So one claim can list a Vitest unit test, a Playwright spec and a pytest test
together. The record's `defenders.byRunner` says which file ran where. The
evidence lists every runner that ran under `run.runners`. When two owning
runners both list the same file, the probe refuses. It does not guess.

## How a runner is resolved

TestGuard resolves a JavaScript runner from the **project's own package** first.
It uses the version the project pinned, and the package's own `bin` script, run
with the Node that runs TestGuard. Resolution walks up from the project
directory the way Node's `require` does, so it finds a runner hoisted to a
monorepo root. Only when no package resolves does TestGuard ask an executable
on PATH for `--version`.

TestGuard never asks `npx`. The `npx` cache answers
`npx --no-install vitest --version` from a project that has no Vitest at all.
A same-named executable (a Python `playwright` shim, say) answers too. The run
would then happen against nothing.

`playwright` is stricter. It needs both a `playwright.config.{ts,mts,js,mjs,cjs}`
in the project directory and `@playwright/test` resolvable from it.

The evidence records where every resolved runner came from in `runner.source`:

- `project`: the project's own package, its virtualenv, or an interpreter named
  by path.
- `path`: an executable found on PATH, including a bare command name given to
  `--python`.
- `builtin`: `node-test`, the Node running TestGuard.

A `--runner-cmd` resolves nothing and records no source. It records the
command as the runner, with the hash of its parsed words. The command text is
never written to the evidence.

```json
"runner": { "name": "vitest", "version": "3.2.4", "source": "project" }
"runner": { "name": "node-test", "version": "24.18.0", "source": "builtin" }
```

A `--runner-cmd` run records the command, never the adapter that reads its
report:

```json
"runner": { "name": "custom-command", "commandHash": "4b0f6c2a…" }
```

A Python run records the engine that actually ran, never the adapter name:

```json
"runner": { "name": "unittest", "version": "CPython 3.12.13", "source": "path" }
```

The runner is part of what a verdict measured. A later probe reuses a verdict
only when it records the same name, version and source. For a `--runner-cmd`,
it must record the same command hash instead.

An unresolvable runner is a precondition failure (exit `2`). It is never a
verdict about the tests.

## `vitest`

**When it is chosen.** First in `auto`, or `--runner vitest`.

**How files are discovered.** TestGuard asks Vitest itself:
`vitest list --filesOnly --passWithNoTests --maxWorkers=1`. Vitest loads its
own config and workspace, so the universe is exactly what `vitest run` would
collect. TestGuard hashes the config files Vitest reads (`vitest.config.*`,
`vite.config.*`, `vitest.workspace.*`) into the evidence. Editing one
invalidates reused verdicts.

**How it runs.** `vitest run <files> --reporter=json --outputFile=<tmp>
--maxWorkers=<N>`, plus `--no-file-parallelism` when only one worker is
allowed. TestGuard reads the report from the file, never from stdout.

**Proof.** [`fixtures/known-answer`](../../fixtures/known-answer/README.md)
reproduces every verdict in its `expected.json` under Vitest.

## `jest`

**When it is chosen.** Second in `auto`, or `--runner jest`. It resolves only
when the project directory has a `package.json` or a
`jest.config.{js,mjs,cjs,ts,cts,json}`.

**How files are discovered.** `jest --listTests --json --runInBand`, so Jest's
own `testMatch`, `projects` and ignore patterns decide.

**How defenders are discovered.** TestGuard reads imports and a literal
`moduleNameMapper` from the text. For a test it cannot place that way (a custom
`resolver`, `modulePaths`, a preset such as the Salesforce LWC one, a mapper
that is computed), it asks Jest: `jest --listTests --json --findRelatedTests
<target>`, run in the project with the project's own Jest. The tests Jest lists
are the defenders (`discovery: runner-native`). A failed, timed out or unreadable
answer stays indeterminate and is never read as "no test". There is at most one
process for each target file and discovery configuration, and at most 64 per
probe. Other runners do not have this step yet.

**How it runs.** `jest --ci --json --outputFile=<tmp> --runInBand
--runTestsByPath <files>`, or `--maxWorkers=<N>` instead of `--runInBand` when
`--workers` is above 1. `--runTestsByPath` makes each argument an exact path.
Without it, Jest reads positionals as regular expressions. Then a path with `+`
or `(` silently matches nothing.

**Proof.** [`fixtures/known-answer-jest`](../../fixtures/known-answer-jest/README.md)
— the same claims in CommonJS, the same expected verdicts.

## `playwright`

**When it is chosen.** Per file: a `.spec.*` or `.test.*` file under the
config's `testDir` runs under Playwright whatever the project runner is.
`--runner playwright` makes it the project runner as well.

**How files are discovered.** `playwright test --list --reporter=json`.
Ownership reads `testDir` from the config as text. The config may be
TypeScript, so TestGuard never imports it. TestGuard understands only a string
literal (`testDir: './e2e'`). Without one, the config's own directory is the
test directory, as in Playwright.

**How it runs.** TestGuard calls the project's `@playwright/test` CLI directly
(no npm subprocess per run): `playwright test --reporter=json --workers=<N> <files>`.
The report goes to a file named through `PLAYWRIGHT_JSON_OUTPUT_FILE`.

**What counts.** Playwright marks a test `flaky` when it fails, then passes on
a retry. A flaky test makes the run **not** green. Across N runs it becomes
`FLAKY-DEFENDER`. A `timedOut` test is a timeout and never a kill.

**Servers the specs talk to (`webServer`).** TestGuard sets `CI=1` for every
runner process. The Playwright CLI evaluates the config in that same process.
So `reuseExistingServer: !process.env.CI` is `false` under a probe. Suppose a
server from another checkout is already on the port. Then Playwright refuses
to start, the run is an `error`, and the record is `unverifiable`
(`defenders-failed-to-load`). Playwright's own line is in `detail.message`
("... is already used ...").

Now suppose a config reuses a server regardless of `CI`
(`reuseExistingServer: true`). Then the scratch tree's specs run against the
other checkout's server. The fault never reaches that server, so the negative
control stays green. The record is `unverifiable` (`subject-not-executed`),
and its `detail.message` names the reused server. It is never `survived` or
`killed`. The supported setup:

- derive the port from `TESTGUARD_WORKER` (`4173 + Number(process.env.TESTGUARD_WORKER ?? 0)`), so
  the trees of parallel faults never share a server;
- never reuse an existing server under probe: `reuseExistingServer: false`
  when `TESTGUARD_WORKER` is set, or `!process.env.CI` (which holds under a probe);
- start the server from the config's own directory, so it serves the probed tree.

**Proof.** [`fixtures/known-answer-playwright`](../../fixtures/known-answer-playwright/README.md)
mixes Vitest and browserless Playwright defenders in one project;
[`fixtures/foreign-server-playwright`](../../fixtures/foreign-server-playwright/README.md)
puts a foreign server on the port the config uses.

## `node-test`

**When it is chosen.** Only with `--runner node-test`. `auto` keeps its order
and never selects it.

**Where it comes from.** The Node executable running TestGuard. TestGuard
installs nothing. The evidence records `runner.source: "builtin"` and the
actual Node version.

**How files are discovered.** Node's own default collection: the files
`node --test` would run with no arguments. Discovery loads each test module
with every test body filtered out. So a module's top-level code does run
during discovery.

**How it runs.** Every confirmation uses fresh processes. `--workers` sets the
test concurrency. Sometimes exactly one test file is selected and Node is 22.8
or later in the 22 line, 24 or 26. Then the file runs in one fresh process
rather than a controller plus a child.

**Limits.** Plain JavaScript with default Node loading. The runner refuses
when `NODE_OPTIONS` or `NODE_PATH` is set. Custom loaders and module-mocking
configurations are outside this adapter. It needs Node 20 or newer. CI checks
the floor against the fixture on Node 20.0.0.

**Proof.** [`fixtures/known-answer-node`](../../fixtures/known-answer-node/README.md).
To reproduce the narrow native-runner comparison, install this repository's
pinned development dependencies. Then run this from a checkout of the
repository:

```bash
node .github/scripts/benchmark-node-runner.mjs --out /absolute/receipt-dir
```

It sends 17 identical classifier inputs and four existing faults through
complete probes with three confirmations, fresh worker receipts and reversed
execution order. The results describe that workload and runtime only.

## `maven`

**When it is chosen.** Only with `--runner maven`. The project directory must
hold a `pom.xml`; run from the module that has one.

**Where it comes from.** The project's own `./mvnw` when it has one. It is never
second-guessed: a wrapper that fails is named in the refusal, and TestGuard does
not fall back to `mvn` behind it. Without a wrapper, `mvn` on PATH. A probe runs in a
scratch checkout, which holds only what git tracks, so commit the wrapper and its
`.mvn` directory. `check`
runs `--version` and records the Maven version; `source` is `project` for a
wrapper and `path` for PATH. Windows is not verified: use `--runner-cmd` there.

**How files are discovered.** The globs `**/src/test/java/**/*Test.java`,
`*Tests.java`, `*TestCase.java` and `Test*.java`, and the same names as `.kt`
under `src/test/kotlin`. A helper class that matches (`TestSupport`) is in the
universe, and a run that selects it reports no suite for it and is an `error`.
The universe is bound to the hash of every `pom.xml` and `.mvn/` setting.

**How it runs.** `mvn -B test -Dtest=<classes> -Dsurefire.failIfNoSpecifiedTests=false
-DfailIfNoTests=false`. A defender's class is the path after `src/test/java/`
with dots for slashes. A defender in a module below the project adds `-pl
<modules> -am`; a module is the nearest directory with a `pom.xml`. Before the
build, the `target/surefire-reports` and `target/failsafe-reports` directories of
those modules are removed. Afterwards, only XML written during the run is read.

**What counts.** A JUnit 5 `AssertionFailedError` or a `java.lang.AssertionError`
is an assertion. Any other exception type is an exception. No report is an
`error`; for a fault the engine records `fault-invalid` with the compiler's first
`[ERROR]` line. A class the build did not report is an `error`. A failed build
beside reports with no failure is an `error`, because another module may not
have built.

**Limits.**

- Not run against a real Maven. The `-Dtest=<package.Class>` form is the first
  thing to confirm. If Surefire reads nothing from it, you get an `error`, never
  a pass.
- Only the `test` phase runs. Failsafe reports are read when the project binds
  Failsafe into it; `mvn verify` is not run.
- `target/classes` is kept between runs for speed. Maven recompiles a changed
  source file, and the negative control catches a stale class: a broken file that
  leaves the defenders green is not allowed to produce `survived`.
- A `@Nested` class counts as its outer class having run.
- With `--in-place`, the report directories it removes are the ones in your own
  `target/` (Maven) or `build/` (Gradle). The scratch worktree is where a normal
  probe runs.

## `gradle`

**When it is chosen.** Only with `--runner gradle`. The project directory must
hold `build.gradle`, `build.gradle.kts`, `settings.gradle` or
`settings.gradle.kts`.

**Where it comes from.** The project's `./gradlew`, else `gradle` on PATH, as for
Maven.

**How files are discovered.** The same test names as `maven`. The universe is
bound to every Gradle build file, `gradle.properties`, the version catalog and
the wrapper settings.

**How it runs.** `gradle --no-daemon --console=plain --no-build-cache --continue
:cleanTest :test --tests <class>`, once for each module with a defender
(`:billing:cleanTest :billing:test --tests <class>`). These flags are not
optional. A daemon outlives the process tree, so the budget could not end the
run. An up-to-date or cached `test` task writes no new report. `--continue`
attempts every module. Reports are read from `build/test-results/test`, after
that directory is removed.

**Limits.**

- Not run against a real Gradle.
- Only the task named `test` is read. An Android `testDebugUnitTest` or an
  `integrationTest` task is not.
- With `--in-place`, the report directory it removes is `build/test-results/test`
  in your own tree.
- A module's Gradle path is its directory path with `:`. A module renamed in
  `settings.gradle` needs `--runner-cmd` with `--report-format junit`.

## `karma`

**When it is chosen.** Only with `--runner karma`, for an Angular workspace. It
needs `angular.json` with a project whose test builder is
`@angular-devkit/build-angular:karma` or `@angular/build:karma`, the project's
`@angular/cli`, `karma-junit-reporter` and a Karma config
(`ng generate config karma`). `check` names the first one that is missing.

**Where it comes from.** The project's own `@angular/cli`, never PATH.

**How files are discovered.** `**/*.spec.ts`. The universe is bound to
`angular.json` and the Karma and TypeScript configs.

**How it runs.** `ng test <project> --watch=false --browsers=ChromeHeadless
--karma-config=<generated> --include=<spec>`. Karma's reporter writes where the
project's own config says, so TestGuard generates a config in the scratch
directory. It loads the project's config, then sets the `junit` reporter, the
output directory and a single run. The generated config and the report are
removed after the run. A spec file in no Angular project with a karma target is
an `error`.

**Limits.**

- Not run against a real Karma or Chrome.
- `karma-junit-reporter` records no exception type for Jasmine, so every kill
  reads as an exception and none as an assertion. `--require-assertion-kill`
  cannot be met under `karma`.
- The reporter writes one suite for each browser, not one for each spec file, so
  the run cannot say that a requested spec did not run. `--include` selects it,
  and a run that collects no test is an `error`.
- Chrome must start in your environment. A container that runs as root needs a
  custom launcher with `--no-sandbox` in your `karma.conf.js`.

## `python`, `pytest` and `unittest`

**When it is chosen.** Third in `auto`; for every `.py` defender whatever the
project runner is; or explicitly. `--runner python` takes pytest when the
interpreter can import it. It takes stdlib `unittest` when the interpreter
cannot. `--runner pytest` and `--runner unittest` pin the engine and fail
rather than fall back, because which engine ran changes what the evidence
means.

**Where it comes from.** The project's interpreter, resolved in this order:

1. `--python <interpreter>` or `TESTGUARD_PYTHON` — when either is set, it is
   the only candidate. Both read a value the same way. TestGuard looks up a bare
   name such as `python3` on PATH. It resolves anything containing `/` as a
   path against the current directory. `probe`, `admit`, `sweep` and `replay`
   all accept `--python`;
2. the active virtualenv (`$VIRTUAL_ENV`);
3. the project's `.venv`, `venv`, then `.env`;
4. `python3`, then `python`, on PATH.

TestGuard resolves it against your working tree, never the scratch worktree. A
virtualenv is gitignored, so the worktree does not contain one.

**How files are discovered.** The globs `test_*.py`, `test*.py` and
`*_test.py` across the project. TestGuard does not consult pytest's
`python_files` and `testpaths` settings. The universe is bound to the hashes of
`pyproject.toml`, `pytest.ini`, `setup.cfg`, `tox.ini` and `conftest.py`, so
editing one invalidates reused verdicts.

**How it runs.** TestGuard installs nothing into the project. Its reporters
reach the interpreter through `PYTHONPATH`.

- pytest: `python -m pytest -p _testguard_pytest_plugin -p no:cacheprovider
  --maxfail=0 -q -p no:xdist <files>`. `--maxfail=0` overrides a `-x` in the
  project's `addopts`; the rest of `addopts` applies.
- unittest: `python -m _testguard_unittest_main <files>`.

Python always runs serially. A configuration that requires `pytest-xdist`
must still work without it. If it does not, the claim stays unproven. TestGuard
does not bypass the worker policy. Python has no per-test timeout without a
plugin, so a hang ends at `--budget`.

**Proof.** [`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md)
runs under both engines in CI, and both must reach the same sixteen verdicts.
The [Python guide](../guides/python.md) covers interpreters, `patch()`, import
provenance and the Python scaffold.

## Custom runners

Use `--runner-cmd` when the built-in command line is not how your project runs
its tests. Examples are a specific config, a workspace filter or a wrapper
script. `probe`, `admit`, `sweep` and `replay` accept it.

```bash
npx testguard-cli probe . --runner-cmd "pnpm vitest run {files} --reporter=json --outputFile={out}"
```

### What the template must contain

| Requirement | Why |
|---|---|
| `{files}` as a word of its own | it expands to one argument per selected test file, relative to the probed directory |
| `{out}` somewhere | TestGuard replaces it with the path of a temporary report file. You may embed it, as in `--outputFile={out}` |
| a report written to `{out}`: the jest-compatible JSON shape, or JUnit XML with `--report-format junit` | by default the parser reads `testResults[]` (each with `status`, `message` and `assertionResults[]` carrying `status`, `fullName` or `title`, `failureMessages`) and the top-level `numTotalTests`, `numPassedTests`, `numFailedTests` and `success`. `vitest --reporter=json` and `jest --json` write it |

Single and double quotes group words. TestGuard does **not** run the command
through a shell: no pipes, no `&&`, no `VAR=value` prefix, no glob expansion.
Use `env VAR=value <cmd>` or a script when you need any of those. The command
runs with the probed directory as its working directory. That is the scratch
worktree, unless you pass `--in-place`.

### JUnit XML reports

Most stacks that TestGuard has no adapter for write JUnit XML. Maven, Gradle
and Karma have adapters of their own (`--runner maven`, `gradle`, `karma`) that
read the same format. For the rest, write it with a command: Maven (Surefire
and Failsafe) in a layout the adapter does not know, Gradle, `pytest --junitxml`, `karma-junit-reporter` and
`sf apex run test --result-format junit`. Add `--report-format junit` (or
`"reportFormat": "junit"` in `testguard.config.json`) and TestGuard reads that
format at `{out}`. You do not write a converter.

```bash
npx testguard-cli probe . --runner-cmd "./tg-mvn.sh {out} {files}" --report-format junit
```

`{out}` is a path where nothing exists yet. Your command may write one XML file
there, or create a directory there and put the reports in it. TestGuard reads
every `.xml` file in that directory (`TEST-*.xml` and any other name), one
level deep. It removes the file or directory after each run.

| In the XML | TestGuard reads it as |
|---|---|
| `<testsuite>` | a test file result |
| `<testcase>` | one test |
| `<failure>` or `<error>` in a test case | a failed test |
| `<skipped>` | a test that did not run: neither passed nor failed |
| a suite with errors and no test case | a load failure. The run is an `error` and says why |
| a suite with no test case and no error | an empty run. It is an `error`, never a pass |

A failed test is an assertion when the `type` attribute of its `<failure>` or
`<error>` is exactly one of these classes: `org.opentest4j.AssertionFailedError`,
`java.lang.AssertionError`, `junit.framework.AssertionFailedError`,
`AssertionFailedError`, `AssertionError` or `System.AssertException`. Any other
type is an exception, even when its message mentions an assertion. When the
reporter writes no `type`, TestGuard reads only the class at the head of the
message (`System.AssertException: Expected: 1`), and only when it is one of
those classes. A message such as `assert 1 == 2` names no class, so it is an
exception. A timeout type (`TestTimedOutException`, `TimeoutException`,
`TimeoutError`) is a timeout, and a timeout never kills.

If your command writes no report and exits with an error (a compile error, for
example), the run is an `error` with the last line of the command's error
output, as for the jest format. A report that is cut short or is not a JUnit
report is an `error` too. TestGuard never reads what it cannot read as a pass.
The format is part of what the evidence records (`run.runner.reportFormat`), so
changing it re-measures every fault. `--report-format` needs `--runner-cmd`.

A report without a `testResults` array makes the defenders unverifiable. The
load message says the command must emit the jest-compatible shape. A template
that is missing `{files}` or `{out}`, or that has an unclosed quote, is a usage
error. The command exits `3` with the reason before anything runs.

### What changes with a custom command

- **One execution boundary.** Every selected defender, including Playwright
  and `.py` files, goes to your one command.
- **A static test universe.** The universe is the `--runner` adapter's file
  globs (Vitest's under `auto`), the Playwright- and Python-owned files, and
  every file that any claim or fault lists in `defendedBy`. It is not a native
  listing. `--require-origin` cannot certify against it.
- **Escalation only sees that universe.** For a suite the adapter's globs do
  not know (JUnit, Apex, MUnit), a test that no claim declares is not in the
  universe. To let a survivor be checked against the rest of your suite, name
  the suite with `--test-glob` (repeatable), for example
  `--test-glob "src/test/**/*Test.java"`. It is a glob relative to the
  project, written with `/`. The same list can live in the `testGlobs` key of
  `testguard.config.json`. The files it matches join the universe, beside the
  adapter's globs and the declared defenders. `node_modules`, build output and
  the scratch directory are never searched. `--test-glob` needs `--runner-cmd`
  and exits `3` without it. You can still list a test in the `defendedBy` of a
  claim instead. When the universe has no test outside the defenders,
  escalation is skipped. The record says
  `detail.escalationSkipped: "no-test-outside-defenders"`, and the console line
  says `[escalation skipped: the test universe has no test outside the
  defenders]`. Read such a `SURVIVED` as "not yet checked against other tests".
- **No worker flags.** `--workers` and `--serial` do not edit your command.
  Put the runner's own parallelism flags in the template.
- **The template is part of reuse.** The test universe's hash binds the
  parsed command and the `--test-glob` patterns. So changing the
  `--runner-cmd`, or adding or changing a glob, re-measures every fault.
  Reformatting whitespace that parses to the same words does not, and neither
  does the order of the globs. A run with no `--test-glob` hashes as it did
  before the option existed. TestGuard never writes the command text to the
  evidence, only the hash. TestGuard never reuses a verdict whose defenders
  failed to load. So after you fix a broken command, TestGuard always measures
  again.
- **`replay` takes `--test-glob` too.** The files it matches join the replay
  universe. But `replay` still relates a test to the reverted source by its
  imports, which TestGuard reads for JavaScript, TypeScript and Python only. A
  test in another language joins the universe and is never run by `replay`.

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
`pnpm --filter <package> exec` runs the command in that package's directory.
That is also the probed directory, so the relative `{files}` paths line up:

```bash
npx testguard-cli probe packages/billing --runner-cmd "pnpm --filter @acme/billing exec vitest run {files} --reporter=json --outputFile={out}"
```

Do not use a filter that moves the command into a different directory from
the one you probe. The `{files}` paths are relative to the probed directory,
and the runner would look for them in the wrong place.
[Monorepos](../guides/monorepo.md) covers the layouts in full.

## Not supported yet

- **Languages other than JavaScript, TypeScript, Python and, with a build
  file, Java and Kotlin.** Defender discovery, the scaffold, anchor syntax
  checks and `gate` cover only the extensions in the matrix above and the
  Java and Kotlin support described under [Java, Kotlin and Angular](#java-kotlin-and-angular).
  `gate` reports a changed file in a known language it cannot probe (Apex,
  Scala, C#, Go, Ruby, PHP, DataWeave, Salesforce Flow, Mule XML, and Java or
  Kotlin with no build file) as `unsupported-language`, and
  `gate --strict` fails on it. `status` counts these files beside the
  supported modules. A claim on such a file is `nocover` with the reason
  `defender-discovery-unsupported (java): declare defendedBy`: discovery could
  not look, so it does not say that the tests are missing. `init` prints a note
  when a project has files in these languages and no JavaScript, TypeScript or
  Python source. Every other file is `non-source`.
- **Built-in runners beyond Vitest, Jest, Playwright, Node's test runner and
  Python.** Others go through `--runner-cmd` and need a reporter that writes
  the jest-compatible shape, or JUnit XML with `--report-format junit`. The
  contract that a new built-in adapter must meet is
  [`spec/RUNNER-ADAPTER.md`](../../spec/RUNNER-ADAPTER.md).
- **TypeScript, custom loaders, `NODE_OPTIONS` and module mocking under
  `node-test`.**
- **Parallel Python runs.** Python is serial. `pytest-xdist` is disabled.
- **Test generation.** The acceptance half exists (`admit`). Writing the test
  stays the agent's job.
- **AST-aware producers.** The scaffold is deterministic line heuristics.
- **Transferring a calibration between repositories.** `replay` measures a
  calibration now. Whether it carries to a repository with no history is
  unproven. See [Replay](../guides/replay.md).

## Next

- [Python](../guides/python.md) — probing a Python project end to end
- [Monorepos](../guides/monorepo.md) — nested projects, `--node-modules`, per-package CI
- [Performance](../guides/performance.md) — workers, budgets and why a gate gets slow
- [CLI reference](cli.md) — every flag on every command
