# Python

This guide is for probing a Python project, or the Python half of a mixed
repository. It explains which interpreter TestGuard uses and how it picks
pytest or the standard library's `unittest`. It explains how TestGuard finds
the tests that defend a module. It also covers the three places where Python
behaves differently from JavaScript. In each of those places, a naive port
would give a confident wrong answer.

## Probe it

TestGuard installs nothing into your project. It carries its own reporters
and puts them on the interpreter's `PYTHONPATH`. So a codebase whose test
dependencies are the standard library gets no new dependencies.

```bash
npx testguard-cli probe .                              # auto: pytest if importable, else stdlib unittest
npx testguard-cli probe . --runner unittest            # pin the stdlib engine
npx testguard-cli probe . --python .venv/bin/python    # name the interpreter
```

You need Node 20 or newer to run TestGuard and Python 3.8 or newer to probe.
pytest is optional. When TestGuard uses pytest, its plugin supports pytest 7,
8 and 9.

## Which interpreter

TestGuard tries these in order and takes the first one that answers:

1. `--python <interpreter>` or `TESTGUARD_PYTHON`. When you set either one, it
   is the **only** candidate. Suppose you name an interpreter and TestGuard
   quietly replaces it. The tests then run against different dependencies, and
   nothing in the evidence shows the change.
2. The active virtualenv, `$VIRTUAL_ENV`.
3. The project's own `.venv`, then `venv`, then `.env`.
4. `python3`, then `python`, on PATH.

TestGuard resolves the interpreter against your working tree, never the
scratch worktree that the probe runs in. Git ignores a virtualenv, so the
worktree does not contain one. TestGuard references it by absolute path, which
is how you are meant to use virtualenvs.

`--python` and `TESTGUARD_PYTHON` take the same values and mean the same
thing. TestGuard reads them the way a shell reads a command. It looks up a bare
name such as `python3` or `python3.12` on PATH. Anything that contains a `/`
(for example `.venv/bin/python`) is a path, and TestGuard resolves it against
the current directory. `probe`, `admit`, `sweep` and `replay` all accept
`--python`.

The evidence records where the interpreter came from in `run.runner.source`.
The value is `project` for a virtualenv, the project's own environment or an
interpreter named by path. The value is `path` for an interpreter found on PATH
(including a bare name given to `--python`).

When no interpreter answers, the probe stops with exit `2`:

```
no usable Python interpreter (tried …); install Python 3.8+, or point --python / TESTGUARD_PYTHON at one
```

## pytest or unittest

`--runner auto` (the default) and `--runner python` use **pytest** when the
chosen interpreter can import it. They use stdlib **unittest** when it cannot.
`unittest` is not a lesser option. It is the only engine that runs a project
whose test dependencies are the standard library. Those codebases choose this
on purpose, and they are the ones most worth probing.

The evidence records the engine that actually ran, never the adapter name.
`--runner pytest` fails instead of quietly using `unittest`, because the
engine that ran changes what the evidence means:

```
pytest is not importable from <interpreter> (pip install pytest, or use --runner unittest for the stdlib runner)
```

| Engine | Command | Notes |
|---|---|---|
| pytest | `python -m pytest -p _testguard_pytest_plugin -p no:cacheprovider --maxfail=0 -q -p no:xdist <files>` | your `addopts` apply, except that `--maxfail=0` overrides a `-x`. Stopping at the first failure would hide which tests failed, and that list names undeclared killers during escalation |
| unittest | `python -m _testguard_unittest_main <files>` | imports each test module itself. So a module that fails to import is a load error, not a test that "failed" |

Both write a JSON report to a file that TestGuard names, never to stdout. So
you cannot mistake test output for a result. Both run with
`PYTHONDONTWRITEBYTECODE=1` and a `PYTHONPYCACHEPREFIX` outside the tree. Python
validates a `.pyc` by the source's mtime in whole seconds and its size. Without
these settings, a fault of the same length applied within the same second could
get served from a stale cache and never run.

How Python outcomes count:

| Outcome | Counts as |
|---|---|
| passed | passed |
| failed (an `AssertionError` or any other exception raised by the test) | a failure that can kill a fault, as under Jest |
| failed by a timeout | a timeout; never a kill |
| xfail, skipped | neither passed nor failed |
| xpass | the run is **not** green. It reaches `FLAKY-DEFENDER` through the ordinary N-run rules and kills nothing |
| collection or import error | the suite did not load. This is how a fault whose replacement does not parse reaches `FAULT-INVALID` |

Python has no per-test timeout without a plugin. So a hanging test ends at
`--budget` (default `120000` ms per run). Set it to fit your slowest defender.

## How the tests that defend a module are found

TestGuard discovers the defenders of a claim with no `defendedBy`. They are
the test files that import the fault's module and do not replace it
wholesale.

**Candidates** are the files that match `test_*.py`, `test*.py` or `*_test.py`.
TestGuard does not read pytest's `python_files` and `testpaths` settings. So
you must list a test with any other name in `defendedBy`.

**Matching is by module name**, the way Python itself matches. A file at
`src/billing/invoice.py`, with `src/billing/__init__.py` present and no
`src/__init__.py`, is the module `billing.invoice`. A test reaches it the same
way whatever puts `src/` on `sys.path`: a `conftest.py`, a `sys.path.insert`,
pytest's `pythonpath` setting or an installed distribution. All of these count
as importing it:

```python
import billing.invoice
from billing.invoice import total
from billing import invoice
from . import invoice                       # relative imports, resolved against the test's package
importlib.import_module("billing.invoice")  # a string literal
```

TestGuard recognizes a package by its `__init__.py`. It names a namespace
package without one from the file alone (`invoice`). So a test that imports
`billing.invoice` does not match it. Add the `__init__.py` or declare
`defendedBy`.

**On `sys.path` at run time.** The unittest engine puts the project directory
on `sys.path`, as `unittest discover` would. It also adds each test file's
import root (the first directory above it that is not a package). pytest runs
as `python -m pytest` from the project directory and applies its own `rootdir`
and `conftest.py` rules. TestGuard hashes the root `conftest.py`,
`pyproject.toml`, `pytest.ini`, `setup.cfg` and `tox.ini` into the evidence.
So editing one of them invalidates reused verdicts.

## `patch()` is not `vi.mock`

`vi.mock('./mod')` replaces a whole module. So a JavaScript test that mocks
the target can detect nothing in it, and TestGuard drops it as a defender.
`patch("billing.invoice.send")` replaces **one attribute**. A fault anywhere
else in `billing.invoice` is still detectable. If TestGuard copied the
JavaScript rule, it would drop tests that defend the module well. It would
report `NOCOVER` for a claim that is covered.

So:

- A patch of the **module itself** (`patch("billing.invoice")`) removes the
  file as a defender. If the file never asserts on anything that it took from
  the module, it carries the `mocked-never-asserted` signal.
- A patch of an **attribute** keeps the file as a defender. It adds the
  `target-attribute-patched` signal, which names the attributes. A fault in one
  of them is where that test is least likely to notice.

TestGuard recognizes `patch`, `patch.object`, `patch.dict`, `setattr` and
`setitem` with a string target, bare or prefixed by `mock.`, `unittest.mock.`,
`mocker.` or `monkeypatch.`. To silence a patch that you intend not to assert,
add `# unasserted: <why>` on the line or up to two lines above it. The comment
keeps the reason visible.

[`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md)
fixes both cases: `PATCHED-001` (attribute patch, killed, with the signal)
and `EXPORT-002` (module patch, `NOCOVER`, with `mocked-never-asserted`).

## The fault has to be the code that ran

Node loads files by path, so a fault applied in the scratch worktree is the
code that runs. Python loads modules through import finders. Python consults a
**meta path finder** before every `sys.path` entry. A strict editable install
registers one (`pip install -e . --config-settings editable_mode=strict`, and
some build backends by default). Then the tests import your original file while
TestGuard faults the copy. The result is a green baseline and every claim
`SURVIVED`. The report looks like a disaster, and it is entirely false.

So, with the fault applied, TestGuard asks the interpreter which file it
actually imported. If that file is outside the tree that the probe uses,
TestGuard **refuses** the whole run (exit `2`) with this message:

```
<file>: the fault was applied to <worktree>/<file>, but the interpreter imported <path> instead.
Python loaded a different copy of this module, so nothing TestGuard changes can ever run and every
claim would be reported as SURVIVED however good the tests are. The usual cause is an install that
registers an import hook ahead of sys.path — a strict editable install (`pip install -e .
--config-settings editable_mode=strict`, and some build backends by default) — or a plain install
that left a copy in site-packages. Either reinstall the project against the tree being probed, or
run with --in-place so the tree the install points at is the tree that is faulted.
```

Do these in order of preference:

1. **Run in place.** `probe . --in-place` faults your working tree, which is
   the tree that the install points at, and restores it afterwards. Only the
   fault target files have to be clean. Test files may be dirty.
2. **Make the tests import the checkout they run in.** Remove a stale copy
   from `site-packages` (`pip uninstall <dist>`). Replace a strict editable
   install with one that does not register an import hook. Then a
   `conftest.py` or pytest's `pythonpath` setting decides where the package
   comes from.

Suppose no defender imported the module at all. TestGuard does not refuse that
run, because it shows the reach of the tests, not a problem with the install.
The record carries `detail.targetNotImported`, and the probe warns. The
negative control turns what would have been a survivor into `UNVERIFIABLE`
with reason `subject-not-executed`. So you cannot read "the tests were never
there" as "the tests are blind here".

## Scaffold for `.py` files

```bash
npx testguard-cli scaffold demo/redact.py   # → .testguard/scaffold-redact.json, a draft
```

The Python producers propose the same fault classes as JavaScript, in Python
syntax:

| Shape | Example |
|---|---|
| `condition-forced` | `if not ctx:` → `if False:` |
| `statement-deleted` | `rules = compile_rules(patterns)` → `pass` |
| `return-altered` | `return <check>` → `return True` |
| `literal-changed` | `verify=True` → `verify=False`; cost, rounds, TTL and window values weakened |
| `call-removed` | a bare `verify…()` / `validate…()` / `check…()` call removed |
| `field-dropped` | a key dropped from a payload `dict` or an allow-list |
| `argument-swapped` | a parameter-derived argument swapped for `None`: `mask(text, rules)` → `mask(None, rules)` |

Three differences are on purpose:

- **TestGuard replaces a statement with `pass`, never deletes it.** A block
  whose only statement is gone is an `IndentationError`. A fault that cannot
  compile is a `FAULT-INVALID` verdict. That spends a probe run and says
  nothing about the tests.
- **TestGuard never removes a line that leaves a bracket open.** It also never
  removes a line inside a bracket that an earlier line opened. `COLOURS = {`
  looks like an assignment, and removing it orphans everything below.
- **TestGuard does not propose a module-level dunder assignment**
  (`__version__`, `__all__`, `__author__`). Deleting one does change behavior,
  but nobody writes a test for it. A survivor there would teach the scaffold's
  survival-learned ordering to prefer a barren class. The rule is narrow on
  purpose. TestGuard still proposes a module-level constant such as
  `DEFAULT_MAX_SIZE = 100`, because removing a real default changes a real
  default.

TestGuard never proposes `field-dropped` inside tests, `conftest.py`, fixtures
or migrations. The two JSX shapes (`element-removed`, `handler-dropped`) have no
meaning in Python. TestGuard leaves them out and does not fake them. Every
proposal is a draft. [Writing claims](writing-claims.md) covers how to turn one
into a claim.

## Mixed JavaScript and Python claims

A `.py` defender runs under Python whatever the project runner is. So a Vitest
test and a pytest test can defend one claim at once:

```json
"defendedBy": ["test/export.test.ts", "tests/test_export.py"]
```

The record's `defenders.byRunner` says which file ran under which engine, and
`run.runners` in the evidence lists every runner that ran.

Discovery stays within a language. TestGuard matches a fault in a `.py` file
against Python tests, and a fault in a JavaScript file against JavaScript
tests. List cross-language defenders in `defendedBy`.

In a mixed repository, leave `--runner` at `auto` (or the JavaScript runner).
`--runner pytest` or `--runner unittest` makes Python the project runner. A
JavaScript defender then belongs to no resolved runner, so the probe refuses.
The `.py` defenders already use pytest whenever the interpreter can import it.

## In CI

The GitHub Action and the GitLab template take a `python` input, which they
pass as `--python`. Set it when your dependencies live in a virtualenv that the
job created. The GitLab template's default Node image has no Python, so set its
`image` input to one that has Python. See [GitHub Actions](ci/github-actions.md) and
[GitLab CI](ci/gitlab.md).

## Next

- [Languages and runners](../reference/languages-and-runners.md) — the full support matrix
- [Writing claims](writing-claims.md) — faults, anchors and `defendedBy`
- [Verdicts](../reference/verdicts.md) — every verdict and signal, including `target-attribute-patched`
- [Monorepos](monorepo.md) — a Python package beside JavaScript packages
