"""Runs stdlib unittest test files and writes a per-test report, for
corpus/derive.mjs. Independent of TestGuard's own reporter on purpose: the key
must not be produced by the tool it judges.

usage: python unittest_runner.py <report.json> <test file>...   (cwd: project root)

Report: {"tests": {id: "pass" | "skip" | "fail:assertion" | "fail:exception"},
         "loadError": str | null}
A failure is unittest's own classification: `failures` are assertion failures
(the test's AssertionError), `errors` are any other exception. A module that
cannot be imported is a load error, never a failed test.
"""
import json
import os
import sys
import unittest


class Recorder(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.outcomes = {}
        self.load_errors = []

    def addSuccess(self, test):
        self.outcomes[test.id()] = "pass"

    def addSkip(self, test, reason):
        self.outcomes[test.id()] = "skip"

    def addFailure(self, test, err):
        self.outcomes[test.id()] = "fail:assertion"

    def addError(self, test, err):
        if type(test).__name__ in ("_FailedTest", "ModuleImportFailure") or test.id().startswith("unittest.loader"):
            self.load_errors.append(f"{test.id()}: {err[0].__name__}: {err[1]}")
        else:
            self.outcomes[test.id()] = "fail:exception"

    def addExpectedFailure(self, test, err):
        self.outcomes[test.id()] = "pass"

    def addUnexpectedSuccess(self, test):
        self.outcomes[test.id()] = "fail:exception"


def main():
    report, files = sys.argv[1], sys.argv[2:]
    sys.path.insert(0, os.getcwd())
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    result = Recorder()
    for f in files:
        name = f[:-3].replace("/", ".") if f.endswith(".py") else f
        try:
            suite.addTests(loader.loadTestsFromName(name))
        except Exception as exc:  # a module that will not import
            result.load_errors.append(f"{name}: {type(exc).__name__}: {exc}")
    suite.run(result)
    with open(report, "w") as fh:
        json.dump({"tests": dict(sorted(result.outcomes.items())), "loadError": "; ".join(result.load_errors) or None}, fh)
    failed = any(v.startswith("fail") for v in result.outcomes.values()) or result.load_errors
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
