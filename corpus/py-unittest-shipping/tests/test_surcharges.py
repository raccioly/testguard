import unittest

from shipping import InvalidPostalCode, is_remote, remote_surcharge


class IsRemoteTests(unittest.TestCase):
    def test_prefix_99_is_remote(self):
        for code in ("99000", "99120", "99999"):
            self.assertTrue(is_remote(code), code)

    def test_range_80000_to_80499_is_remote(self):
        for code in ("80000", "80250", "80499"):
            self.assertTrue(is_remote(code), code)

    def test_just_outside_range_not_remote(self):
        self.assertFalse(is_remote("79999"))
        self.assertFalse(is_remote("80500"))

    def test_near_99_prefix_not_remote(self):
        self.assertFalse(is_remote("98999"))
        self.assertFalse(is_remote("90000"))

    def test_ordinary_codes_not_remote(self):
        for code in ("10001", "30301", "00000"):
            self.assertFalse(is_remote(code), code)


class InvalidPostalCodeTests(unittest.TestCase):
    def assert_invalid(self, value, text):
        with self.assertRaises(InvalidPostalCode) as cm:
            is_remote(value)
        self.assertEqual(str(cm.exception), text)

    def test_too_short(self):
        self.assert_invalid("1234", "InvalidPostalCode: 1234")

    def test_too_long(self):
        self.assert_invalid("123456", "InvalidPostalCode: 123456")

    def test_letters(self):
        self.assert_invalid("abcde", "InvalidPostalCode: abcde")

    def test_empty(self):
        self.assert_invalid("", "InvalidPostalCode: ")

    def test_embedded_space(self):
        self.assert_invalid("12 45", "InvalidPostalCode: 12 45")

    def test_trailing_newline(self):
        with self.assertRaises(InvalidPostalCode):
            is_remote("12345\n")

    def test_non_ascii_digits(self):
        with self.assertRaises(InvalidPostalCode):
            is_remote("\uff11\uff12\uff13\uff14\uff15")

    def test_integer_rejected(self):
        self.assert_invalid(12345, "InvalidPostalCode: 12345")

    def test_none_rejected(self):
        self.assert_invalid(None, "InvalidPostalCode: None")


class RemoteSurchargeTests(unittest.TestCase):
    def test_remote_standard(self):
        self.assertEqual(remote_surcharge("99120", "standard"), 275)

    def test_remote_express(self):
        self.assertEqual(remote_surcharge("99120", "express"), 400)

    def test_range_remote_standard_and_express(self):
        self.assertEqual(remote_surcharge("80499", "standard"), 275)
        self.assertEqual(remote_surcharge("80000", "express"), 400)

    def test_non_remote_is_zero(self):
        self.assertEqual(remote_surcharge("10001", "standard"), 0)
        self.assertEqual(remote_surcharge("10001", "express"), 0)
        self.assertEqual(remote_surcharge("80500", "express"), 0)

    def test_invalid_code_raises(self):
        with self.assertRaises(InvalidPostalCode) as cm:
            remote_surcharge("9912", "standard")
        self.assertEqual(str(cm.exception), "InvalidPostalCode: 9912")


if __name__ == "__main__":
    unittest.main()
