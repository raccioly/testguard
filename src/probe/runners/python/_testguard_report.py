"""
Shared report writing for TestGuard's two Python reporters.

TestGuard never installs anything into the project under test. Both reporters
are put on PYTHONPATH from the tool's own package and loaded from there, so a
project with zero test dependencies stays a project with zero test
dependencies.

The report is TestGuard's own shape, not jest's. `unittest` and `pytest` both
distinguish an assertion failure from a collection/import error natively, and
that distinction is the whole point of the adapter: flattening it into a
foreign shape would throw away the best signal Python offers and move the
verdict semantics out of the tested JavaScript and into here.

Shape (schemaVersion 1):

    {
      "testguard": 1,
      "runner": "pytest" | "unittest",
      "rootdir": "<absolute dir the run started from>",
      "collectionErrors": [{"file": str, "message": str}],
      "tests": [{"id": "<file>::<name>", "file": str, "name": str,
                 "outcome": "passed"|"failed"|"skipped"|"xfail"|"xpass",
                 "phase": "setup"|"call"|"teardown",
                 "exceptionType": str|null, "message": str|null,
                 "failureKind": "assertion"|"exception"|null}],
      "provenance": {"<relative target path>": "<absolute path actually
                      imported>" | null}
    }

`failureKind` classifies a failed test from the exception's TYPE, never its
text: `assertion` when the exception is an `AssertionError` (or a subclass, or
pytest's own `fail`/`raises` outcome), `exception` otherwise. `null` on a test
that did not fail; a reader treats a missing value as `exception`, the
pessimistic side.

`provenance` is the Python-specific precondition. A scratch git worktree
isolates Node for free, because Node loads files by path. Python does not: an
editable install (PEP 660 puts an import hook ahead of every path entry) or a
site-packages copy means the interpreter loads the ORIGINAL file while
TestGuard has faulted the copy. The baseline stays green, every fault
SURVIVES, and the result is a confident lie. So every reporter reports which
file the interpreter actually loaded, and the JavaScript side refuses to
proceed when that is not the file it faulted.
"""

import json
import os
import sys

ENV_OUT = "TESTGUARD_REPORT"
ENV_TARGETS = "TESTGUARD_TARGETS"

MAX_MESSAGE = 4000


def clip(text):
    """One bounded string. A pytest longrepr can be megabytes; the report is read whole."""
    if text is None:
        return None
    s = str(text)
    return s if len(s) <= MAX_MESSAGE else s[:MAX_MESSAGE] + "\n… (truncated)"


def kind_of(exc_type):
    """`assertion` for an AssertionError subclass; `exception` for anything else, or for an unknown type."""
    try:
        return "assertion" if isinstance(exc_type, type) and issubclass(exc_type, AssertionError) else "exception"
    except TypeError:
        return "exception"


def merge_kind(existing, new):
    """A test with several errors is an assertion when any one of them is."""
    return "assertion" if "assertion" in (existing, new) else new


def targets():
    """Fault target files (project-relative) whose import provenance must be proved."""
    raw = os.environ.get(ENV_TARGETS)
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        return []
    return [t for t in value if isinstance(t, str)] if isinstance(value, list) else []


def module_tail(rootdir, rel):
    """
    The trailing path that identifies `rel` as a module wherever it is imported
    from: its basename preceded by every parent directory that is a package
    (`__init__.py`). `src/websec/core.py` with `src/websec/__init__.py` present
    and no `src/__init__.py` gives `websec/core.py` — which is what a
    site-packages copy of the same module would also end with.
    """
    parts = [os.path.basename(rel)]
    directory = os.path.dirname(os.path.join(rootdir, rel))
    # Bounded: a package nesting deeper than this is pathological, and an
    # unbounded walk on a malformed tree would climb to the filesystem root.
    for _ in range(32):
        if not os.path.isfile(os.path.join(directory, "__init__.py")):
            break
        parts.insert(0, os.path.basename(directory))
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return os.path.join(*parts)


def provenance(rootdir):
    """
    For each target: the absolute file the interpreter actually loaded for it,
    or None when no module with that tail was loaded at all.

    Read from `sys.modules` after the tests have run, so it reflects the real
    `sys.path` the suite ran under — including anything a `conftest.py`, a
    `pyproject.toml` `pythonpath`, or an editable-install hook did to it. A
    separate `find_spec` subprocess could not see any of that.
    """
    out = {}
    loaded = []
    for module in list(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if not path:
            continue
        try:
            loaded.append(os.path.realpath(path))
        except OSError:
            continue
    for rel in targets():
        tail = module_tail(rootdir, rel)
        match = None
        for path in loaded:
            if path == tail or path.endswith(os.sep + tail):
                match = path
                break
        out[rel] = match
    return out


def write(runner, rootdir, tests, collection_errors):
    """Write the report where TestGuard asked for it. Never to stdout: a test may print anything."""
    out_path = os.environ.get(ENV_OUT)
    if not out_path:
        return
    document = {
        "testguard": 1,
        "runner": runner,
        "rootdir": rootdir,
        "collectionErrors": collection_errors,
        "tests": tests,
        "provenance": provenance(rootdir),
    }
    directory = os.path.dirname(out_path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle)
