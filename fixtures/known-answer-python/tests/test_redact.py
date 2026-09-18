"""
The exhibit. `test_writes_an_audit_row` checks three keys of the audit row and
never checks `content`, so a row carrying the raw input passes — and so does a
row with no `content` key at all. Line coverage of that line is 100%.
"""

import unittest

from demo.redact import compile_rules, mask, redact


class Store:
    def __init__(self):
        self.rows = []

    def write_audit(self, row):
        self.rows.append(row)


class TestRedact(unittest.TestCase):
    def test_masks_the_secret(self):
        store = Store()
        out = redact("token abc123 here", [r"abc\d+"], {"scope": "g1"}, store)
        self.assertNotIn("abc123", out)

    def test_writes_an_audit_row(self):
        store = Store()
        redact("token abc123 here", [r"abc\d+"], {"scope": "g1"}, store)
        self.assertEqual(len(store.rows), 1)
        row = store.rows[0]
        self.assertEqual(row["action"], "MASK")
        self.assertEqual(row["scope"], "g1")
        self.assertEqual(row["rule_count"], 1)

    def test_an_invalid_pattern_is_skipped(self):
        rules = compile_rules(["(unclosed", r"\d+"])
        self.assertEqual(len(rules), 1)

    def test_mask_replaces_with_equal_length_asterisks(self):
        self.assertEqual(mask("abc123", compile_rules([r"abc\d+"])), "******")
