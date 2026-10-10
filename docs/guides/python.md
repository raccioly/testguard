# Python

This guide is for probing a Python project, or the Python half of a mixed
repository: which interpreter TestGuard uses, how it picks pytest or the
standard library's `unittest`, how it finds the tests that defend a module,
and the three places Python behaves differently from JavaScript. Each of those
three is a place a naive port would have produced a confident wrong answer.

## Probe it

Nothing is installed into your project. TestGuard carries its own reporters
and puts them on the interpreter's `PYTHONPATH`, so a codebase whose test
dependencies are the standard library keeps none.

```bash
npx testguard-cli probe .                              # auto: pytest if importable, else stdlib unittest
npx testguard-cli probe . --runner unittest            # pin the stdlib engine
npx testguard-cli probe . --python .venv/bin/python    # name the interpreter
```

You need Node 20 or newer to run TestGuard and Python 3.8 or newer to probe.
pytest is optional; when it is used, TestGuard's plugin supports pytest 7, 8
and 9.

## Which interpreter

TestGuard tries these in order and takes the first that answers:

1. `--python <path>` or `TESTGUARD_PYTHON`. When either is set it is the
   **only** candidate: an interpreter you named and TestGuard quietly replaced
   would change which dependencies the tests ran against without changing
   anything the evidence says.
2. The active virtualenv, `$VIRTUAL_ENV`.
3. The project's own `.venv`, then `venv`, then `.env`.
4. `python3`, then `python`, on PATH.

The interpreter is resolved against your working tree, never the scratch
worktree the probe runs in. A virtualenv is gitignored, so the worktree does
not contain one; it is referenced by absolute path, the way virtualenvs are
meant to be used.

`--python` is a path and is resolved against the current directory, so pass
`.venv/bin/python` rather than a bare command name. `TESTGUARD_PYTHON` is used
exactly as given. Only `probe` accepts `--python`; for `admit`, `sweep` and
`replay`, set `TESTGUARD_PYTHON`.

When nothing answers, the probe stops with exit `2`:

```
no usable Python interpreter (tried …); install Python 3.8+, or point --python / TESTGUARD_PYTHON at one
```

## pytest or unittest

`--runner auto` (the default) and `--runner python` use **pytest** when the
chosen interpreter can import it and stdlib **unittest** when it cannot.
`unittest` is not a fallback for the poor: it is the only engine that runs a
project whose test dependencies are the standard library, which is a
deliberate choice in exactly the codebases most worth probing.

The evidence records the engine that actually ran, never the adapter name.
`--runner pytest` fails rather than quietly using `unittest`, because which
engine ran changes what the evidence means:

```
pytest is not importable from <interpreter> (pip install pytest, or use --runner unittest for the stdlib runner)
```

| Engine | Command | Notes |
|---|---|---|
| pytest | `python -m pytest -p _testguard_pytest_plugin -p no:cacheprovider --maxfail=0 -q -p no:xdist <files>` | your `addopts` apply, except that `--maxfail=0` overrides a `-x`: stopping at the first failure would hide which tests failed, and that list names undeclared killers during escalation |
| unittest | `python -m _testguard_unittest_main <files>` | imports each test module itself, so a module that fails to import is a load error rather than a test that "failed" |

Both write a JSON report to a file TestGuard names, never to stdout, so test
output cannot be mistaken for a result. Both run with
`PYTHONDONTWRITEBYTECODE=1` and a `PYTHONPYCACHEPREFIX` outside the tree: a
`.pyc` is validated by the source's mtime in whole seconds and its size, so a
same-length fault applied within the same second could otherwise be served
from a stale cache and never run.

How Python outcomes count:

| Outcome | Counts as |
|---|---|
| passed | passed |
| failed (an `AssertionError` or any other exception raised by the test) | a failure that can kill a fault, as under Jest |
| failed by a timeout | a timeout; never a kill |
| xfail, skipped | neither passed nor failed |
| xpass | the run is **not** green; it reaches `FLAKY-DEFENDER` through the ordinary N-run rules rather than killing anything |
| collection or import error | the suite did not load; this is how a fault whose replacement does not parse reaches `FAULT-INVALID` |

Python has no per-test timeout without a plugin, so a hanging test ends at
`--budget` (default `120000` ms per run). Size it to your slowest defender.

## How the tests that defend a module are found

A claim with no `defendedBy` gets its defenders discovered: the test files
that import the fault's module and do not replace it wholesale.

**Candidates** are the files matching `test_*.py`, `test*.py` or `*_test.py`.
pytest's `python_files` and `testpaths` settings are not consulted, so a test
named any other way must be listed in `defendedBy`.

**Matching is by module name**, the way Python itself matches. A file at
`src/billing/invoice.py`, with `src/billing/__init__.py` present and no
`src/__init__.py`, is the module `billing.invoice`. A test reaches it the same
way whether `src/` got onto `sys.path` through a `conftest.py`, a
`sys.path.insert`, pytest's `pythonpath` setting or an installed distribution.
These all count as importing it:

```python
import billing.invoice
from billing.invoice import total
from billing import invoice
from . import invoice                       # relative imports, resolved against the test's package
importlib.import_module("billing.invoice")  # a string literal
```

A package is recognised by its `__init__.py`. A namespace package without one
is named from the file alone (`invoice`), so a test importing
`billing.invoice` is not matched to it: add the `__init__.py` or declare
`defendedBy`.

**On `sys.path` at run time.** The unittest engine puts the project directory
on `sys.path`, plus each test file's import root (the first directory above it
that is not a package), as `unittest discover` would. pytest runs as
`python -m pytest` from the project directory and applies its own `rootdir`
and `conftest.py` rules. The root `conftest.py`, `pyproject.toml`,
`pytest.ini`, `setup.cfg` and `tox.ini` are hashed into the evidence, so
editing one invalidates reused verdicts.

## `patch()` is not `vi.mock`

`vi.mock('./mod')` replaces a whole module, so a JavaScript test that mocks
the target can detect nothing in it and is dropped as a defender.
`patch("billing.invoice.send")` replaces **one attribute**: a fault anywhere
else in `billing.invoice` is still detectable. Copying the JavaScript rule
would drop tests that defend the module perfectly well and report `NOCOVER`
for a claim that is covered.

So:

- A patch of the **module itself** (`patch("billing.invoice")`) removes the
  file as a defender. If the file never asserts on anything it took from the
  module, it carries the `mocked-never-asserted` signal.
- A patch of an **attribute** keeps the file as a defender and adds the
  `target-attribute-patched` signal naming the attributes: a fault in one of
  them is where that test is least likely to notice.

TestGuard recognises `patch`, `patch.object`, `patch.dict`, `setattr` and
`setitem` with a string target, bare or prefixed by `mock.`, `unittest.mock.`,
`mocker.` or `monkeypatch.`. Silence an intended unasserted patch, visibly,
with `# unasserted: <why>` on the line or up to two lines above it.

[`fixtures/known-answer-python`](../../fixtures/known-answer-python/README.md)
pins both cases down: `PATCHED-001` (attribute patch, killed, with the signal)
and `EXPORT-002` (module patch, `NOCOVER`, with `mocked-never-asserted`).

## The fault has to be the code that ran

Node loads files by path, so a fault applied in the scratch worktree is the
code that runs. Python loads modules through import finders, and a
**meta path finder** is consulted before every `sys.path` entry. A strict
editable install registers one (`pip install -e . --config-settings
editable_mode=strict`, and some build backends by default). Then the tests
import your original file while TestGuard faults the copy: a green baseline,
every claim `SURVIVED`, and a report that reads as a catastrophe while being
entirely false.

So, with the fault applied, TestGuard asks the interpreter which file it
actually imported. If that file is outside the tree being probed, the whole
run is **refused** (exit `2`) with this message:

```
<file>: the fault was applied to <worktree>/<file>, but the interpreter imported <path> instead.
Python loaded a different copy of this module, so nothing TestGuard changes can ever run and every
claim would be reported as SURVIVED however good the tests are. The usual cause is an install that
registers an import hook ahead of sys.path — a strict editable install (`pip install -e .
--config-settings editable_mode=strict`, and some build backends by default) — or a plain install
that left a copy in site-packages. Either reinstall the project against the tree being probed, or
run with --in-place so the tree the install points at is the tree that is faulted.
```

What to do, in order of preference:

1. **Run in place.** `probe . --in-place` faults your working tree, which is
   the tree the install points at, and restores it afterwards. Only the fault
   target files have to be clean; test files may be dirty.
2. **Make the tests import the checkout they run in.** Remove a stale copy
   from `site-packages` (`pip uninstall <dist>`), and replace a strict editable
   install with one that does not register an import hook, so that a
   `conftest.py` or pytest's `pythonpath` setting decides where the package
   comes from.

When no defender imported the module at all, the run is not refused: that is
a fact about the tests' reach, not about the install. The record carries
`detail.targetNotImported`, the probe warns, and the negative control turns
what would have been a survivor into `UNVERIFIABLE` with reason
`subject-not-executed`, so "the tests were never there" cannot read as "the
tests are blind here".

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

Three differences are deliberate:

- **A statement is replaced with `pass`, never deleted.** A block whose only
  statement is gone is an `IndentationError`, and a fault that cannot compile
  is a `FAULT-INVALID` verdict: a probe run spent saying nothing about the
  tests.
- **A line that leaves a bracket open is never removed**, nor one inside a
  bracket opened on an earlier line. `COLOURS = {` looks like an assignment,
  and removing it orphans everything below.
- **A module-level dunder assignment is not proposed** (`__version__`,
  `__all__`, `__author__`). Deleting one does change behaviour, but nobody
  writes a test for it, and a survivor there would teach the scaffold's
  survival-learned ordering to prefer a barren class. The rule is narrow on
  purpose: a module-level constant such as `DEFAULT_MAX_SIZE = 100` is still
  proposed, because removing a real default changes a real default.

`field-dropped` is never proposed inside tests, `conftest.py`, fixtures or
migrations. The two JSX shapes (`element-removed`, `handler-dropped`) have no
Python meaning and are absent rather than faked. Every proposal is a draft;
[Writing claims](writing-claims.md) covers turning one into a claim.

## Mixed JavaScript and Python claims

A `.py` defender runs under Python whatever the project runner is, so one
claim can be defended by a Vitest test and a pytest test at once:

```json
"defendedBy": ["test/export.test.ts", "tests/test_export.py"]
```

The record's `defenders.byRunner` says which file ran under which engine, and
`run.runners` in the evidence lists every runner that ran.

Discovery stays within a language: a fault in a `.py` file is matched against
Python tests, and a fault in a JavaScript file against JavaScript tests. List
cross-language defenders in `defendedBy`.

In a mixed repository leave `--runner` at `auto` (or the JavaScript runner).
`--runner pytest` or `--runner unittest` makes Python the project runner, and
a JavaScript defender then belongs to no resolved runner, so the probe
refuses. The `.py` defenders already use pytest whenever the interpreter can
import it.

## In CI

The GitHub Action and the GitLab template take a `python` input, passed as
`--python`; set it when your dependencies live in a virtualenv the job
created. The GitLab template's default Node image has no Python, so set its
`image` input to one that does. See [GitHub Actions](ci/github-actions.md) and
[GitLab CI](ci/gitlab.md).

## Next

- [Languages and runners](../reference/languages-and-runners.md) — the full support matrix
- [Writing claims](writing-claims.md) — faults, anchors and `defendedBy`
- [Verdicts](../reference/verdicts.md) — every verdict and signal, including `target-attribute-patched`
- [Monorepos](monorepo.md) — a Python package beside JavaScript packages
