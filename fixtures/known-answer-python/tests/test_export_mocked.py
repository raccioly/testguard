"""
The only test that imports the export module replaces it wholesale and never
asserts on anything from it. A patch of the module itself cannot detect a fault
in the module: discovery must find NO defender here.
"""

import unittest
from unittest.mock import patch

import demo.export


class TestExportMocked(unittest.TestCase):
    def test_uses_a_replaced_module(self):
        with patch("demo.export") as fake:
            fake.export_rows.return_value = []
            self.assertEqual(fake.export_rows([{"content": "secret"}]), [])
