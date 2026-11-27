# Apex runner adapter (specification, not built)

Status: **specification only.** No code implements this document. The adapter
runs code inside a Salesforce org, and the rules below cannot be confirmed
without a real org. Nobody has run them against one. Build the adapter only
after the checks in [What a real org must confirm](#what-a-real-org-must-confirm)
pass on a sandbox. Until then a claim on an Apex file works as far as anchors
and the gate go (`claims --check-anchors`, `gate`, `status`; the gate names Apex
as an unsupported language), and `probe` cannot run it.

This document extends [`RUNNER-ADAPTER.md`](RUNNER-ADAPTER.md). Read that
contract first: every export, the report shape and the five `run` rules apply
here without change. This page says only what Apex adds.

It answers [issue #335](https://github.com/raccioly/testguard/issues/335).

## Why Apex is different

Every built-in adapter runs the code on the developer's machine, in a scratch
copy of the project. Apex code runs only inside an org. A fault is therefore not
a file edit that a local process reads. It is a **deployment** to a shared,
remote system, and the system keeps that deployment until someone deploys
something else.

Three consequences shape the whole design:

1. **A failed restore is a failure of the measurement, not of the run.** If the
   original file is not back in the org, every later verdict was measured
   against a faulty org.
2. **The org is shared state.** One fault at a time. See `sharedExternalState`
   in the contract.
3. **The org must be one the user is allowed to damage.** A sandbox or a scratch
   org. Never production.

## Name, detection and ownership

| Item | Rule |
|---|---|
| `name` | `apex`. |
| `auto` | Never picks it. It deploys, so the user asks for it with `--runner apex`. |
| `check({ projectDir })` | Succeeds only when all of these hold: `sfdx-project.json` exists in the directory the run uses; `sf --version` answers; a target org is named (`--target-org <alias-or-username>` or `"apexOrg"` in `testguard.config.json`); the org answers `sf org display`; the org is not production (next section). The failure message names the first thing that is missing and the command that fixes it. |
| `owns(projectDir, file)` | A `.cls` file under a `packageDirectories` path of `sfdx-project.json` whose source contains an `@IsTest` annotation (any case). Test classes only. |
| `tests(projectDir)` | The owned `.cls` files. This is the test universe that escalation uses. |
| `extensions` | `['.cls', '.trigger']`. When the adapter ships, Apex moves out of the gate's list of unsupported languages (`KNOWN_SOURCE` in `src/gate/languages.mjs`) and becomes probeable when `sfdx-project.json` is above the file, the same design as Java under a build file. The conformance test holds both halves. |
| `sharedExternalState` | `true`. |
| `producers` | Not in the first version. A claim on Apex declares its faults by hand. A producer set for Apex is separate work with its own compile-safety tests. |

## The org is never production

`check()` reads the org with `sf data query --query "SELECT Id, IsSandbox, TrialExpirationDate FROM Organization" --target-org <org> --json`
and refuses unless `IsSandbox` is `true` or `TrialExpirationDate` is set (a
scratch or trial org). A production org is refused with a message that names the
rule. There is no flag that overrides it in the first version. A later version
may add one only with a decision from the maintainer and a warning that names
what the user accepts.

The evidence records the 15-character org id and nothing else about the org: no
username, no instance URL, no alias. A verdict is tied to the org it was
measured in, so reuse across orgs is refused (see [Evidence](#evidence)).

## One fault, one cycle

The scratch tree holds the faulty file. The adapter owns the whole cycle for a
defender set:

1. **Deploy the fault.** `sf project deploy start --source-dir <fault file> --target-org <org> --wait <minutes> --json`.
2. **Run the defenders.** `sf apex run test --class-names <defender classes> --synchronous --result-format json --target-org <org> --wait <minutes> --json`. With many classes, `--tests` per method is not used: the unit is the class, as the contract says the unit is the file.
3. **Restore.** Deploy the original file again, from the clean HEAD copy, the same way as step 1.

The baseline and the negative control use the same cycle with the original and
the fatal edit.

### What each step's failure means

| Step fails with | Verdict or action |
|---|---|
| Deploy rejected for a compile error in the fault | `FAULT-INVALID`, reason `replacement-does-not-compile`. No test runs. The restore still runs, because a partial deploy can leave a component behind. |
| Deploy rejected for another reason (limits, a locked org, a permission) | `error` for the run, not `FAULT-INVALID`. Never a kill. The restore runs. |
| Deploy times out | `timeout` is never a kill. The adapter then verifies by a status query before the restore, so the restore cannot race an unfinished deploy. |
| Test run times out or the CLI dies | `error`, never a kill. The restore runs. |
| Some tests `CompileFail` | A load failure (`error`), as the contract says for a suite that did not load. |
| **Restore fails** | **The whole probe stops** with a precondition error that names the org and the file. It writes the [org state record](#the-org-state-record) first. TestGuard never keeps measuring against an org in an unknown state. |

A process killed between the deploy and the restore (a crash, SIGKILL, a closed
laptop) is the worst case, so the cycle is crash-safe by record, not by hope.

### The org state record

Before step 1 the adapter writes `.testguard/apex-org-state.json` with the org
id, the file, and the SHA-256 of the original source. It removes the record
after a restore that it verified by a second read (for example `sf project retrieve start`
of the file and a hash compare). If a record is present at the start of the next
probe, the adapter first restores that file from the project's HEAD and
verifies it, before any new work, and says so on stderr. If it cannot, it stops
with a precondition error. `testguard clean` reports a leftover record and does
not delete it, because deleting the record hides a dirty org.

The record lives in `.testguard/`, which `init` already keeps out of commits.

## Report mapping

The JSON reporter of `sf apex run test` is read, the same way the JUnit reader is,
by a pure function that has no process (the contract's `parseReport`). Field
names are those of the Salesforce CLI reporter (`salesforcecli/plugin-apex`)
and the `ApexTestResultOutcome` enum (`forcedotcom/salesforcedx-apex`).
**They were read from those sources, not observed from a run**; the first item of
[What a real org must confirm](#what-a-real-org-must-confirm) checks them.

| `sf` JSON | TestGuard run |
|---|---|
| `result.summary.testsRan`, `passing`, `failing`, `skipped` | `tests.total`, `passed`, `failed` |
| `result.tests[].FullName` (`Class.method`) | the test id |
| `Outcome: "Pass"`, `"Fail"`, `"Skip"` | passed, failed, pending |
| `Outcome: "CompileFail"` | a load failure (`error`) |
| `Fail` and `Message` starts with `System.AssertException:` | an assertion kill |
| `Fail` and any other `Message` (`System.NullPointerException:` and so on) | an exception kill |
| A `Fail` whose `Message` names a limit (`System.LimitException:`) or a timeout | never a kill: an `error`, as the contract's never-optimistic rule says for a timeout |

The JSON has no structured error type. So the last three rows use the narrow
header rule of the JUnit reader and of `ASSERTION_HEADER`: only the exception
class at the start of `Message`, never a word further on. Through
`--result-format junit` the `type` attribute decides instead, and the existing
JUnit reader needs `System.AssertException` in its assertion list (it is
already there).

## Serial only, and the budget

`sharedExternalState: true` makes the engine probe one fault at a time in one
tree. A pool of scratch orgs, one per worker, is later work and a separate
design.

One fault is about two deploys and one test run. The reporter estimated 30 to
120 seconds in a scratch org, **not measured**. The default `--budget` of 120
seconds is too short, so the adapter declares its own default (600 seconds, to
confirm) and `--budget` still overrides it. `--changed` selection matters more
here than for a local runner: a full self-probe of a project with hundreds of
faults is hours.

## Evidence

The adapter adds nothing to the verdict rules. It changes these records, and a
spec change goes with the code, as the contract requires:

- `run.runner` is `{ name: "apex", version: <sf version>, source: "path", org: <15-character org id> }`. The `org` key is new and is allowed on this runner only. Reuse compares it, so a verdict measured in one org is never reused in another.
- `run.faultWorkersSource` is `runner` (the contract already defines it).
- A test class that carries `SeeAllData=true` is a flake risk: the verdict depends on org data. The adapter records `detail.signals` `see-all-data` for it, and the defender is never counted as an independent kill source. This reuses the existing `signals` list, which never changes a verdict.

## Test level and the universe

`tests()` lists the `@IsTest` classes locally. Escalation runs `--class-names`
for the rest of the project when the set is small, and `--test-level RunLocalTests`
when it is too large for the command line. The adapter counts the classes it
passes and switches at a fixed number to confirm on an org (a long `--class-names`
list has a limit).

## Not covered here

- **Flow tests.** The same library models Flow test results. A Flow leg (for
  example `sf logic run test` where the installed CLI has it) could defend
  `.flow-meta.xml` claims with the same deploy, run, restore cycle. It is a
  separate adapter or a second mode, with its own spec.
- **Managed packages, namespaces and unlocked packages.** The first version
  handles one unmanaged source package directory. A namespace changes the class
  names in the report and in `--class-names`.
- **Pooled scratch orgs.**
- **Code coverage.** TestGuard measures whether a fault is caught, not which lines run.
- **LWC Jest.** `@salesforce/sfdx-lwc-jest` is a Jest run and uses the `jest`
  adapter, with the Jest layers for discovery that already exist.

## What a real org must confirm

Do all of these on a **sandbox or a scratch org** before any code is written,
and record the answers in this file. An unchecked item is a reason not to build.

1. **Report shape.** Run `sf apex run test --synchronous --result-format json --json` against a project with one passing, one failing-by-assertion, one failing-by-exception and one non-compiling test. Confirm the field names and the `Outcome` values in the mapping table, and that the assertion message starts with `System.AssertException:`.
2. **Deploy of one file.** Confirm `sf project deploy start --source-dir <file>` deploys a single class, and what its JSON says for a compile error, for a limit, and for a locked org. Confirm the exit codes.
3. **Restore.** Confirm a second deploy of the original restores the class, and that a retrieve-and-hash read proves it. Measure whether a failed first deploy can leave a component half-deployed.
4. **Interrupt.** Kill the CLI between deploy and restore and confirm the org state record repairs the org on the next probe.
5. **Time.** Measure the real cost of one cycle and set the default budget from it.
6. **The org check.** Confirm the `Organization` query for `IsSandbox` and `TrialExpirationDate` on a sandbox, a scratch org, a developer edition org and a production org (read only).
7. **`--class-names` limit.** Find the number of classes at which the command line must switch to `--test-level RunLocalTests`.
8. **Test isolation.** Confirm that a test run does not see a fault deployed by an earlier cycle after the restore, including for static state and for scheduled or queued Apex.

## Build order, when the checks pass

1. The pure parts first: the report parser, the selector mapping, the org check's decision on a query result, the state record's repair decision. All with unit tests and a fake `sf`.
2. `check`, `tests`, `owns` and the registration, with the contract's conformance test.
3. The cycle with the state record and the restore rules, tested with a fake `sf` that can fail at each step.
4. The gate and `status` stop listing Apex as unsupported, as in the `extensions` row.
5. A run against a real sandbox, recorded in this file, before the first release that names it.
