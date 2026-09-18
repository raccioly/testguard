"""
Fails on every odd-numbered run, through a counter file next to the fixture.
That makes this suite deliberately unreliable: it is how the `flaky-defender`
verdict is exercised, and it is why the fixture is never run as part of the
tool's own suite.
"""

import os
import unittest

COUNTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".flake-counter")


def _next_run():
    n = 0
    if os.path.exists(COUNTER):
        with open(COUNTER, encoding="utf-8") as handle:
            n = int(handle.read().strip() or "0")
    n += 1
    with open(COUNTER, "w", encoding="utf-8") as handle:
        handle.write(str(n))
    return n


class TestFlaky(unittest.TestCase):
    def test_alternates(self):
        self.assertEqual(_next_run() % 2, 0, "fails on every odd run, by design")
