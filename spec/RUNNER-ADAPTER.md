# Runner adapter contract

A runner adapter is the module that lets the probe engine run one test runner.
The engine does not depend on a language. A fault is a find-and-replace on a
file, and a verdict is "did these tests fail". Everything that is specific to
a stack lives in an adapter: how to see if the runner is there, which test
files exist, how to run a set of them under a time limit, and how to read what
came back.

This page is the published contract. It was written from the adapters in
`src/probe/runners/` (`vitest`, `jest`, `playwright`, `python`, `node-test`),
and extended by the build-system adapters `maven`, `gradle` and `karma`
(see [Built-in adapters on JUnit XML](#built-in-adapters-on-junit-xml)).
A conformance test holds every one of them to it:
[`conformance/runner-adapter.test.mjs`](conformance/runner-adapter.test.mjs)
runs the structural check in [`lib/runner-adapter.mjs`](lib/runner-adapter.mjs).
A new runner is a reviewed module that passes this check, not a fork.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## The module

An adapter is an ES module. Its named exports are the contract. A module MAY
export more (helpers, `argvFor`, discovery parsers); the engine reads only the
names below.

| Export | Required | Type | Purpose |
|---|---|---|---|
| `name` | yes | string | The runner's identity in the evidence (`run.runner.name`). |
| `check` | yes | function | Is the runner usable in this project, and which version? |
| `run` | yes | function | Run a set of test files under a time limit and report the result. |
| `tests` | unless `discoverTests` is present | function | The test files the runner would collect, as a list. |
| `discoverTests` | unless `tests` is present | function | The same, asked of the runner itself, as a hashed manifest. |
| `testGlobs` | no | string[] | The conventional test file names of this runner. |
| `owns` | no | function | Does this runner own this file whatever the project runner is? |
| `fatalEdit` | no | function | The text that makes a file of this language fail to load. |
| `parseReport` | no | function | The pure function that turns the runner's report into a run result. |
| `sharedExternalState` | no | boolean | `true`: the runner uses one org, server or database for every run. |
| `extensions` | no | string[] | The source extensions this adapter makes probeable. |
| `producers` | no | object | The language's fault producers, for `scaffold` and `sweep`. |

The structural check also requires `name` to be a lowercase identifier
(`^[a-z][a-z0-9-]*$`), and `owns` to be paired with `tests`.

### `name`

A lowercase identifier. It is what the evidence records as the runner, and
verdict reuse requires the same name. When one adapter has several engines
(`python` runs `pytest` or `unittest`), the adapter reports the engine in
`check` and the evidence records the engine that ran, never the module name.

A `--runner-cmd` run records `custom-command`, never an adapter name: under a
command template the adapter only reads the report.

### `check({ projectDir, sourceDir, python, budgetMs, budgetFor })`

Called when the runner is selected (`--runner <name>`, or `auto`), and for
every owning adapter (see `owns`) before its first file runs. It MUST NOT
start a test run. It returns a promise of one of:

- `{ ok: true, version, source?, engine? }`. `version` is required and
  non-empty: it is bound into the test universe hash. `source` is `project`
  (a package resolved from the project), `path` (an executable found on
  `PATH`) or `builtin`. `engine` names the engine that will run when the
  module has more than one.
- `{ ok: false, message }`. `message` says what is missing and the command
  that fixes it. The engine puts it in the refusal, so write it for a person.

`budgetMs` is the time the check may take. An adapter that starts a process to
answer MUST end it at that limit.

### `tests(projectDir)` and `discoverTests({ projectDir, version, timeoutMs, maxOutputBytes })`

An adapter MUST provide at least one of them. They answer the question that
escalation, `nocover` and the negative control depend on: which test files does
this runner collect?

- `tests(projectDir)` returns an array of project-relative paths with forward
  slashes, or an empty array. It is synchronous and reads the file system. It
  is the simple form, and it is the one the Python adapter uses.
- `discoverTests(...)` asks the runner itself, without executing a test, and
  returns a manifest made by `createDiscoveryManifest` in
  `src/probe/runners/discovery.mjs`:
  `{ schemaVersion: 1, runner: { name, version }, source, files, configFiles,
  projects?, testUniverseHash }`. `files` are sorted and de-duplicated.
  `configFiles` lists every configuration file the answer depends on, each as
  `{ path, sha256 }`, so that the universe cannot be reused across a
  configuration edit. The adapter MUST read the configuration hashes before
  and after listing and throw `DiscoveryError` when they differ. When present,
  `discoverTests` wins over `tests`.

The universe MUST be the runner's own view. A runner that resolves but lists
no test file is not selected under `auto`, and is refused when named: zero
observations are not evidence.

### `testGlobs`

The glob patterns of the runner's conventional test file names. The adapter's
own `tests` uses them. The engine does not read them.

### `owns(projectDir, file)`

Synchronous, returns a boolean. A runner that owns files rather than projects
(Playwright: a file under its `testDir`; Python: a `.py` file) answers `true`
for them, and the engine runs those defenders under it whatever the project
runner is. That is what lets one claims file mix Vitest and Python defenders.
An adapter that exports `owns` MUST export `tests` too: the engine uses it to
list the owned files.

The set of owning adapters is fixed in the engine (`OWNED_RUNNERS` in
`src/probe/runners/index.mjs`). A new owning adapter is added there.

### `run(options)`

Runs `options.files` and returns a promise of a run result. This is where the
guarantees of the engine are kept, so the rules are strict.

`options` the engine passes:

| Field | Meaning |
|---|---|
| `projectDir` | The tree to run in. Under `worktree` mode it is a scratch copy of the project. Run in this directory and no other. |
| `sourceDir` | The original project directory. Use it to resolve what a scratch copy lacks (an interpreter, an installed package). Never run tests in it. |
| `files` | The test files to run: project-relative paths from the adapter's own universe. |
| `budgetMs` | A hard wall-clock limit for this run. |
| `serial`, `workers` | The worker ceiling the user chose. `serial` means one test file at a time. |
| `python` | The interpreter the user named (`--python`). Only the Python adapter reads it. |
| `targets` | The files the fault changed. An adapter that can tell which file the runtime loaded MAY report it in `provenance`. |
| `projects` | Project membership per file, from the discovery manifest, for a runner that has projects. |
| `commandTemplate`, `reportFormat` | Set only for `--runner-cmd`. See below. |

The result is `{ run, timeouts, loadMessage?, failedTests, provenance?, teardown? }`:

- `run` is `{ outcome, tests: { total, passed, failed }, assertionFailures,
  exceptionFailures, kindNotReported?, durationMs }`. `outcome` is `pass`,
  `fail`, `error` or `timeout`.
- `timeouts` counts the tests or runs that timed out.
- `loadMessage` is present and non-empty whenever `outcome` is `error`: the
  runner's own words when it gave any, else a fixed sentence.
- `failedTests` are stable ids of the failed tests.

The rules:

1. **A time limit that holds.** `budgetMs` is the limit of the whole process
   tree, not of the test body. A synchronous infinite loop ignores the
   runner's own timeout. The adapter MUST end the tree and report `timeout`.
   `runProcess` in `src/probe/runners/shared.mjs` does this and every built-in
   adapter uses it. An adapter MUST NOT leave a process behind.
2. **Never optimistic.** A run that cannot be read is `error` with a message,
   never `pass`. No report, an unreadable report, a report of a shape the
   adapter does not know, and zero tests collected are all `error`. A test
   that was skipped is neither passed nor failed.
3. **A kill is a failed test that is neither a timeout nor a load failure.**
   Only such a failure counts in `assertionFailures` or `exceptionFailures`. A
   suite that does not load, and a test that times out, are never evidence
   that a suite defends a claim.
4. **Assertion or exception is read from structured identity.** An assertion
   is what the runner says it is: an error class, a code, an operator, a
   matcher result. It is never read from message wording. When the runner
   reports nothing to read, the failure is an exception, and `kindNotReported`
   counts it. Unknown means exception.
5. **No state between runs.** Two runs of the same files in the same tree MUST
   not differ because of the first. Anything the adapter writes goes under
   the scratch directory (`scratchRoot()` in `src/scratch-dir.mjs`).

The built-in adapters reach rules 1 to 4 by calling `runProcess` with the
runner's argument vector and its report parser. A new adapter SHOULD do the
same.

**Custom commands.** With `--runner-cmd`, the engine passes `commandTemplate`
(and `reportFormat`) in `options`, and `runProcess` expands `{files}` and
`{out}` and reads the report. An adapter that spreads `options` into
`runProcess` supports this with no further code. `reportFormat` is `jest`
(the jest-compatible JSON report, the default) or `junit` (JUnit XML, one
file or a directory of them at `{out}`, read by `src/probe/runners/junit.mjs`).

### `fatalEdit()`

Returns the text that replaces a whole source file so that the language's
parser or loader refuses it: for JavaScript `/* ... */ (`, for Python
`# ... (`. For a language where those do not fail (XML), return text that does
(a lone `<`). The engine uses it for the negative control: it breaks the file,
runs the defenders, and a defender that stays green never executed the file,
so a `survived` verdict about it is not allowed to stand.

Optional. An adapter without it gets no negative control and its verdicts are
unchanged. The function MUST return a non-empty string, MUST NOT throw, and
MUST NOT depend on the file.

### `parseReport(report, durationMs, kinds?)`

Optional, pure. Turns the runner's report (already parsed from JSON or XML)
into the `{ run, timeouts, loadMessage, failedTests }` above. It exists so
that the parser can be tested on a report file with no process. The engine
calls it only through `run`.

### `sharedExternalState`

`true` when every run of this runner uses one external resource that two runs
cannot share: a Salesforce org that tests deploy into, a Mule runtime, a
database, a server on a fixed port. The default is `false`.

When any runner of a probe (the project runner or an owning one) declares it,
the engine probes one fault at a time in one scratch tree, whatever
`--fault-workers`, `TESTGUARD_FAULT_WORKERS`, `faultWorkers` in
`testguard.config.json` or `auto` asked for. It says so on stderr when that
changed the width. The evidence records no `run.faultWorkers`, and
`run.faultWorkersSource` is `runner` (see [Fault fan-out](GATE-SEMANTICS.md#fault-fan-out)).
Only the literal `true` has an effect.

The adapter is still responsible for one run at a time within itself: the
engine runs defender sets of one fault one after another, but a runner that
takes `workers` MUST NOT use them against the shared resource.

### `extensions`

The source extensions this adapter makes probeable, each lowercase with its
leading dot: `['.java']`, `['.cls', '.trigger']`. An empty list is invalid;
omit the export instead.

The gate and `status` run with no runner selected, so they read a fixed table
in `src/gate/languages.mjs`, in three parts:

- `SOURCE_EXT`: source that is probeable in every project (JavaScript,
  TypeScript, Python).
- `BUILD_SOURCE`: source that is probeable **only where the project has the
  adapter's build file**. A `.java` or `.kt` file is claimable source when a
  `pom.xml` (`maven`) or a Gradle build file (`gradle`) is in the directory of
  the file, or in any directory above it up to the project. Each entry names the
  adapters that can run it. Without a build file the file is a gap, as before:
  `unsupported-language`, never `non-source`. The build files that select an
  adapter are `BUILD_MARKERS` in the same module.
- `KNOWN_SOURCE`: languages TestGuard recognizes and cannot probe at all yet.

`sourceClassifier(projectDir)` answers `probeable(file)`, `unsupported(file)`
and `runnersFor(file)` from those tables and the project's files, and it is the
only reader the gate, `status` and `probe --changed` use. **When an adapter
that declares extensions ships, its language moves out of `KNOWN_SOURCE`** into
`SOURCE_EXT` when every project can run it, or into `BUILD_SOURCE` when only a
project with a build file can. The conformance test holds all three: an adapter
extension is in `SOURCE_EXT`, or in a `BUILD_SOURCE` entry that names the
adapter; every `BUILD_SOURCE` entry names adapters that exist and declare the
extension; and no `KNOWN_SOURCE` language is declared by any adapter. The
built-in adapters declare theirs (`.js .mjs .cjs .ts .mts .cts .jsx .tsx` for
the JavaScript adapters and `karma`, `.py` for Python, `.java .kt` for `maven`
and `gradle`).

The test files of a JVM project are recognized by name and place
(`src/test/java`, `src/test/kotlin`, `*Test`, `*Tests`, `*TestCase`, `Test*`), so a
changed test is reported as a test, never as source to scaffold.

### `producers`

An object with the fault producers of the adapter's language, so `scaffold` and
`sweep` propose faults in that language's syntax instead of saying they have
none (#333):

| Member | Meaning |
|---|---|
| `extensions` | The source extensions the shapes apply to. Each MUST be in the adapter's own `extensions`. |
| `proposalsForLine(lines, i, ctx)` | Proposals for line `i`, each `{ faultClass, description, replace }`; the fault's `find` is the line itself. `ctx.params` is the set of parameter names of the enclosing function. |
| `functionHead(line)` | The name of the function a line opens, or `null`. |
| `functionParams(line)` | The parameter names a head line declares. A producer that swaps arguments lists only the parameters it can safely replace. |
| `isComment(line)` | Is this line a comment? `@claim <ID>` annotations are read from comments. |

`faultClass` MUST be one the spec already closes over. A proposal MUST still
compile: a replacement that does not is a `fault-invalid` verdict, a probe run
that says nothing about the tests. The producer MUST NOT assume another
language's literals (no `undefined` in Java; a swapped argument is `null`).

The engine looks a producer set up by source extension, never through `owns`
(which lists the adapter's test files): `scaffold` takes the first adapter that
`sourceClassifier` says is selected by the project for that file, whose
`producers.extensions` names the file's extension. A language of the adapter
without producers (Kotlin under `maven`) is still refused, out loud. Import
discovery is a separate matter: for a file with adapter producers `scaffold`
prefills no `defendedBy` and says so, because TestGuard cannot read Java
imports.

## Registering an adapter

An adapter is available to the engine when it is listed in these places:

1. `RUNNERS` and `RUNNER_NAMES` in `src/probe/runners/index.mjs`.
2. The `runner` enum in [`schemas/config.schema.json`](schemas/config.schema.json).
3. The `--runner` help text, `docs/reference/languages-and-runners.md` and
   `docs/reference/cli.md`; the `runner` inputs of `action.yml` and
   `packaging/gitlab/testguard.gitlab-ci.yml`.
4. `OWNED_RUNNERS` in the same file, only when the adapter owns files.
5. The language table in `src/gate/languages.mjs`, when it declares
   `extensions` (see above).

A build-system adapter is not in `OWNED_RUNNERS`: every owning adapter is
checked on every probe of every project, and starting Maven for a JavaScript
project would change what that probe measures. `maven` and `gradle` are the
project runner when named (`--runner maven`), and `auto` never picks them.

## Built-in adapters on JUnit XML

`maven`, `gradle` and `karma` read JUnit XML through the same reader as
`--report-format junit` ([`src/probe/runners/junit.mjs`](../src/probe/runners/junit.mjs)),
so every rule about a kill is stated once. None is chosen by `auto`; each is
named with `--runner`. When `auto` finds nothing to run and the project says
it uses one of them (a `pom.xml`, a Gradle build file, a Karma builder or
dependency), the refusal leads with that fact and the flag that runs it.

| Adapter | Resolved from | Universe | Command | Report |
|---|---|---|---|---|
| `maven` | the project's `./mvnw`, else `mvn` on PATH; `check` reports `--version` | `**/src/test/java/**/*Test.java`, `*Tests.java`, `*TestCase.java`, `Test*.java`, and the same names as `.kt` under `src/test/kotlin`; bound to every `pom.xml` and `.mvn/` setting | `mvn -B test -Dtest=<classes> -Dsurefire.failIfNoSpecifiedTests=false`, plus `-pl <modules> -am` for a defender below the project | `target/surefire-reports` and `target/failsafe-reports` of each module that holds a defender |
| `gradle` | the project's `./gradlew`, else `gradle` on PATH | the same test files; bound to every Gradle build file and `gradle.properties` | `gradle --no-daemon --no-build-cache --continue :m:cleanTest :m:test --tests <class>` per module | `build/test-results/test` of each module |
| `karma` | the project's `@angular/cli` (never PATH) | `**/*.spec.ts`; bound to `angular.json`, Karma and TypeScript configs | `ng test <project> --watch=false --browsers=ChromeHeadless --karma-config=<generated> --include=<spec>` | the generated config loads the project's Karma config and forces `karma-junit-reporter` into a scratch directory |

A defender is selected by the class its path implies: the path after
`src/test/java/` or `src/test/kotlin/`, with dots for slashes. A build tool
that finds no such class writes no report, and no report is an `error`.

Every run of these adapters keeps the five rules above, and three more that a
build tool makes necessary:

- **No stale report.** The report directories of every module involved are
  removed before the build, and only a file written after the run started is
  read. A report of an earlier run is never this run's report.
- **Every requested class has a suite.** A defender with no suite in the reports
  is an `error`, not a pass for the others (Karma reports one suite per browser,
  so it cannot say this and does not).
- **Exit status and reports agree.** A build that exits non-zero beside reports
  that show no failing test is an `error`: another module may not have built,
  and its tests are missing. No report at all is an `error` that carries the
  build's own first error line. For a fault, the engine reads that as
  `fault-invalid`; for a defender, as a load failure.

`fatalEdit()` for the JVM adapters is a line comment and a lone `(`, which no
Java or Kotlin compiler accepts, so the negative control works: a defender that
stays green over a file that cannot compile never executed it.

The adapters were tested with fake `mvnw`, `gradlew` and `ng` scripts that write
the report files these tools are documented to write. They were **not run
against a real Maven, Gradle, Karma or Chrome**. The `-Dtest=<package.Class>`
form, Gradle's `--tests` on a multi-project build, the module path of a Gradle
project whose directory differs from its name in `settings.gradle`, and the
`--karma-config` and `--include` options of the two Angular karma builders are
the parts to confirm first against a real project. The Karma adapter reads
every Jasmine failure as an exception, because `karma-junit-reporter` records no
exception type, so `--require-assertion-kill` cannot be met under it.

## Evidence

An adapter adds nothing to the evidence format. The runner is recorded as
`{ name, version, source }` from `check`, and verdict reuse requires the same
three. The one field an adapter's declaration changes is
`run.faultWorkersSource: "runner"`.

## What this contract does not cover

- How a test is selected inside a file. The unit is the test file.
- Parallelism between test files inside one run. The adapter and the runner
  decide it, within `workers`.
- Coverage. TestGuard measures whether a fault is caught, not which lines run.

## Conformance

```bash
npx vitest run spec/conformance/runner-adapter.test.mjs
```

`checkRunnerAdapter(adapter)` in [`lib/runner-adapter.mjs`](lib/runner-adapter.mjs)
returns the violations of one module as `{ path, message }`. The test loads
every adapter in `RUNNERS`, expects none, and includes invalid modules to show
that the check can fail. The check is structural: it starts no process. Whether
`run` honors rules 1 to 5 above is the adapter's own test, and a new adapter
MUST have one that proves a hang ends at `budgetMs` and a missing report is
`error`.
