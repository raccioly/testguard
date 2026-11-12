import unittest

from shipping import quote


class QuoteSmokeTests(unittest.TestCase):
    def test_small_standard_parcel(self):
        quote(100, 100, 100, 1000, 1, "standard", "10001")

    def test_medium_express_parcel(self):
        quote(300, 200, 100, 1200, 3, "express", "30301")

    def test_remote_standard_parcel(self):
        quote(650, 100, 50, 1000, 2, "standard", "99120")

    def test_heavy_standard_parcel(self):
        quote(400, 300, 200, 15000, 4, "standard", "60601")


if __name__ == "__main__":
    unittest.main()
