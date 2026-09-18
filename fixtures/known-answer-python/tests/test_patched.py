"""
A defender that patches ONE attribute of the target and asserts on another.
`compile_rules` is replaced; `mask` is exercised for real. This file is a
genuine defender of any fault in `mask` — the JavaScript rule, which drops any
file that mocks the target, would wrongly report this claim as `nocover`.
"""

import re
import unittest
from unittest.mock import patch

from demo.redact import mask


class TestPatched(unittest.TestCase):
    def test_mask_uses_equal_length_asterisks(self):
        with patch("demo.redact.compile_rules", return_value=[re.compile(r"abc\d+")]):
            self.assertEqual(mask("abc123", [re.compile(r"abc\d+")]), "******")
