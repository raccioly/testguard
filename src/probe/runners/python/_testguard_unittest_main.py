"""
TestGuard's stdlib `unittest` runner.

Run as `python -m _testguard_unittest_main <test files…>` from a PYTHONPATH
entry inside the tool's own package. It needs nothing installed anywhere: a
project whose test dependencies are the standard library stays that way, which
is the whole reason this file exists rather than a pytest plugin requirement.

Two deliberate departures from `python -m unittest`:

  * Test modules are imported here, not by the loader. `unittest` turns an
    import failure into a synthetic `_FailedTest` that *errors at run time* —
    indistinguishable, from the outside, from a test that ran and failed. That
    distinction is the difference between "your tests caught the fault" and
    "the fault stopped the suite from loading", so it is made explicitly.

  * Nothing is written to stdout or stderr. `unittest`'s own runner prints its
    summary to stderr, where it interleaves with whatever the tests print —
    the exact trap that makes hand-rolled harnesses report a suite as green
    when it is not. The result is a JSON file or nothing at all.
"""

import importlib
import os
import sys
import traceback
import unittest

import _testguard_report as tg


def _module_for(path):
    """
    `(top_level_dir, dotted_name)` for a test file, the way `unittest discover`
    would resolve it: walk up while the directory is a package, and the first
    directory that is not becomes the import root.
    """
    absolute = os.path.abspath(path)
    parts = [os.path.splitext(os.path.basename(absolute))[0]]
    directory = os.path.dirname(absolute)
    for _ in range(32):
        if not os.path.isfile(os.path.join(directory, "__init__.py")):
            break
        parts.insert(0, os.path.basename(directory))
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return directory, ".".join(parts)


def _rel(path):
    if not path:
        return ""
    try:
        return os.path.relpath(path, os.getcwd()).replace(os.sep, "/")
    except ValueError:
        return str(path).replace(os.sep, "/")


def _file_of(test):
    module = sys.modules.get(getattr(test, "__module__", "") or getattr(type(test), "__module__", ""))
    return _rel(getattr(module, "__file__", None))


class Result(unittest.TestResult):
    """
    Every outcome `unittest` can produce, kept apart.

    `addFailure` (an assertion rejected the behaviour) and `addError` (the test
    body raised something else) are both recorded as `failed`: the JavaScript
    runners already treat a thrown TypeError in a test body as the suite
    noticing, and a Python adapter that disagreed would make the same fault
    kill under jest and survive under unittest. The exception class is reported
    alongside so the difference is never lost, only kept out of the verdict.
    """

    def __init__(self):
        super().__init__()
        self.records = {}

    def _record(self, test):
        key = test.id()
        if key not in self.records:
            file_rel = _file_of(test)
            name = key
            module_name = getattr(test, "__module__", "")
            if module_name and name.startswith(module_name + "."):
                name = name[len(module_name) + 1:]
            self.records[key] = {
                "id": "%s::%s" % (file_rel or "", name),
                "file": file_rel,
                "name": name,
                "outcome": "passed",
                "phase": "call",
                "exceptionType": None,
                "message": None,
            }
        return self.records[key]

    def _fail(self, test, err, outcome="failed"):
        record = self._record(test)
        record["outcome"] = outcome
        record["exceptionType"] = err[0].__name__ if err and err[0] else None
        record["message"] = tg.clip("".join(traceback.format_exception(*err))) if err else None

    def startTest(self, test):
        super().startTest(test)
        self._record(test)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._fail(test, err)

    def addError(self, test, err):
        super().addError(test, err)
        self._fail(test, err)

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._fail(test, err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        record = self._record(test)
        record["outcome"] = "skipped"
        record["message"] = tg.clip(reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._fail(test, err, outcome="xfail")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._record(test)["outcome"] = "xpass"


def main(argv):
    collection_errors = []
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite()

    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())

    for path in argv:
        top_level, dotted = _module_for(path)
        if top_level not in sys.path:
            sys.path.insert(0, top_level)
        try:
            module = importlib.import_module(dotted)
        except BaseException:  # SyntaxError and SystemExit included: both are load failures, not verdicts
            collection_errors.append({"file": _rel(path), "message": tg.clip(traceback.format_exc())})
            continue
        try:
            suite.addTests(loader.loadTestsFromModule(module))
        except BaseException:
            collection_errors.append({"file": _rel(path), "message": tg.clip(traceback.format_exc())})

    result = Result()
    suite.run(result)
    tg.write("unittest", os.getcwd(), list(result.records.values()), collection_errors)
    return 0 if result.wasSuccessful() and not collection_errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
