"""
TestGuard's pytest reporter.

Loaded with `-p _testguard_pytest_plugin` from a PYTHONPATH entry inside the
tool's own package. Nothing is installed into the project under test, so
`pytest` needs no report plugin of its own and the project's dependency set is
untouched — which matters, because the suites most worth probing are often the
ones that deliberately have none.

Only long-stable hooks are used, so one file serves pytest 7, 8 and 9.
"""

import os

import _testguard_report as tg

_tests = {}            # nodeid -> record being assembled
_files = {}            # nodeid -> absolute test file
_collection_errors = []

# `unittest.expectedFailure` on a test that passes reaches pytest as a plain
# failure whose whole report is this string; pytest's own
# `@pytest.mark.xfail` reports the same situation as a pass carrying
# `wasxfail`. Both are the suite's expectation being wrong rather than an
# assertion rejecting the fault, so both must land on `xpass` — otherwise the
# same test would be kill-eligible under pytest and not under unittest.
_UNEXPECTED_SUCCESS = "Unexpected success"

# Worst-first: a later phase never downgrades a test that already failed.
_RANK = {"failed": 4, "xpass": 3, "xfail": 2, "skipped": 1, "passed": 0}


def _rel(path):
    """Project-relative, forward-slashed. pytest's rootdir may be an ancestor of the probed project."""
    if not path:
        return ""
    try:
        return os.path.relpath(path, os.getcwd()).replace(os.sep, "/")
    except ValueError:  # different drive on Windows
        return str(path).replace(os.sep, "/")


def _record(nodeid):
    if nodeid not in _tests:
        file_rel = _rel(_files.get(nodeid)) or nodeid.split("::")[0]
        _tests[nodeid] = {
            "id": nodeid if nodeid.startswith(file_rel) else "%s::%s" % (file_rel, nodeid),
            "file": file_rel,
            "name": nodeid.split("::", 1)[1] if "::" in nodeid else nodeid,
            "outcome": "passed",
            "phase": "call",
            "exceptionType": None,
            "message": None,
        }
    return _tests[nodeid]


def _apply(record, outcome, phase, message, exception_type):
    if _RANK[outcome] < _RANK[record["outcome"]]:
        return
    record["outcome"] = outcome
    record["phase"] = phase
    if message is not None:
        record["message"] = tg.clip(message)
    if exception_type is not None:
        record["exceptionType"] = exception_type


def pytest_collection_modifyitems(items):
    """Absolute path per test, taken while the items still carry it."""
    for item in items:
        path = getattr(item, "path", None) or getattr(item, "fspath", None)
        if path is not None:
            _files[item.nodeid] = str(path)


def pytest_exception_interact(node, call, report):
    """
    The exception's class name, which no report object carries. Recorded but
    never allowed to change a verdict: an assertion failure and a TypeError
    raised by the test body are both the suite rejecting the behaviour, and the
    JavaScript runners already treat them alike. It is reported because it is
    the cheapest thing to look at when a kill turns out to be the wrong kind.

    pytest calls this hook *after* `pytest_runtest_logreport` for the same
    phase, so the record already exists and is amended in place rather than
    read from a map that would still be empty.
    """
    name = getattr(getattr(call, "excinfo", None), "typename", None)
    nodeid = getattr(report, "nodeid", "") or getattr(node, "nodeid", "")
    if name and nodeid in _tests:
        _tests[nodeid]["exceptionType"] = name


def pytest_collectreport(report):
    """
    A module that will not import. This is the load failure: it is what a fault
    whose replacement does not parse looks like from here, and it must never be
    mistaken for the tests rejecting the fault.
    """
    if getattr(report, "failed", False):
        _collection_errors.append({
            "file": _rel(str(getattr(report, "fspath", "") or "")) or report.nodeid,
            "message": tg.clip(report.longrepr),
        })


def pytest_runtest_logreport(report):
    phase = getattr(report, "when", "call")
    record = _record(report.nodeid)
    exception_type = None
    message = tg.clip(report.longrepr) if report.longrepr is not None else None

    if report.failed:
        unexpected_success = isinstance(message, str) and message.startswith(_UNEXPECTED_SUCCESS)
        _apply(record, "xpass" if unexpected_success else "failed", phase, message, exception_type)
    elif report.skipped:
        # pytest reports an xfail as a skip carrying `wasxfail`.
        _apply(record, "xfail" if hasattr(report, "wasxfail") else "skipped", phase, message, exception_type)
    elif report.passed and hasattr(report, "wasxfail"):
        # A test expected to fail that passed: the suite's own expectation is
        # wrong, so the run is not green — but nothing asserted anything about
        # the fault, so it can never be a kill.
        _apply(record, "xpass", phase, message, exception_type)


def pytest_internalerror(excrepr):
    _collection_errors.append({"file": "", "message": tg.clip(excrepr)})


def pytest_sessionfinish(session, exitstatus):
    tg.write("pytest", os.getcwd(), list(_tests.values()), _collection_errors)
