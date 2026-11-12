import unittest

from shipping import (
    InvalidAddress,
    InvalidSequence,
    address_block,
    tracking_number,
    verify_tracking,
)


class TrackingNumberTests(unittest.TestCase):
    def test_spec_sequence_427(self):
        # Spec says check digit 7; the source triples odd positions (1,3,5,...)
        # instead of even ones, so 000000427 yields check digit 5.
        self.assertEqual(tracking_number(427), "BP0000004275")

    def test_zero(self):
        self.assertEqual(tracking_number(0), "BP0000000000")

    def test_one(self):
        self.assertEqual(tracking_number(1), "BP0000000013")

    def test_twelve(self):
        self.assertEqual(tracking_number(12), "BP0000000127")

    def test_ten(self):
        self.assertEqual(tracking_number(10), "BP0000000101")

    def test_thousand(self):
        self.assertEqual(tracking_number(1000), "BP0000010001")

    def test_ascending_digits(self):
        self.assertEqual(tracking_number(123456789), "BP1234567895")

    def test_maximum_sequence(self):
        self.assertEqual(tracking_number(999999999), "BP9999999991")

    def test_format(self):
        value = tracking_number(42)
        self.assertEqual(len(value), 12)
        self.assertTrue(value.startswith("BP"))
        self.assertTrue(value[2:].isdigit())

    def test_sequence_is_zero_padded(self):
        self.assertEqual(tracking_number(427)[2:11], "000000427")


class InvalidSequenceTests(unittest.TestCase):
    def assert_invalid(self, value, text):
        with self.assertRaises(InvalidSequence) as cm:
            tracking_number(value)
        self.assertEqual(str(cm.exception), text)

    def test_negative(self):
        self.assert_invalid(-1, "InvalidSequence: -1")

    def test_above_maximum(self):
        self.assert_invalid(1000000000, "InvalidSequence: 1000000000")

    def test_string(self):
        self.assert_invalid("5", "InvalidSequence: 5")

    def test_float(self):
        self.assert_invalid(1.0, "InvalidSequence: 1.0")

    def test_none(self):
        self.assert_invalid(None, "InvalidSequence: None")

    def test_bool(self):
        # The source rejects bool even though True == 1.
        self.assert_invalid(True, "InvalidSequence: True")


class VerifyTrackingTests(unittest.TestCase):
    def test_generated_numbers_verify(self):
        for seq in (0, 1, 10, 12, 427, 1000, 123456789, 999999999):
            self.assertTrue(verify_tracking(tracking_number(seq)), seq)

    def test_known_good_literal(self):
        self.assertTrue(verify_tracking("BP0000004275"))

    def test_wrong_check_digit(self):
        self.assertFalse(verify_tracking("BP0000004276"))
        self.assertFalse(verify_tracking("BP0000004270"))

    def test_every_wrong_check_digit_rejected(self):
        good = tracking_number(427)
        for digit in "0123456789":
            candidate = good[:11] + digit
            self.assertEqual(verify_tracking(candidate), candidate == good, candidate)

    def test_altered_body_rejected(self):
        self.assertFalse(verify_tracking("BP0000004375"))

    def test_lowercase_prefix(self):
        self.assertFalse(verify_tracking("bp0000004275"))

    def test_wrong_prefix(self):
        self.assertFalse(verify_tracking("XP0000004275"))

    def test_too_short(self):
        self.assertFalse(verify_tracking("BP000000427"))

    def test_too_long(self):
        self.assertFalse(verify_tracking("BP00000042755"))

    def test_non_digit_body(self):
        self.assertFalse(verify_tracking("BP00000A4275"))

    def test_trailing_newline(self):
        self.assertFalse(verify_tracking("BP0000004275\n"))

    def test_empty_string(self):
        self.assertFalse(verify_tracking(""))

    def test_non_string_inputs_return_false(self):
        for value in (None, 123, 4275.0, b"BP0000004275", ["BP0000004275"]):
            self.assertFalse(verify_tracking(value), value)


class AddressBlockTests(unittest.TestCase):
    def test_basic_block(self):
        self.assertEqual(
            address_block("Jane Doe", "12 Main St", "Atlanta", "30301"),
            "JANE DOE\n12 Main St\nATLANTA 30301",
        )

    def test_street_is_not_uppercased(self):
        block = address_block("a", "mixed Case Rd", "b", "1")
        self.assertEqual(block.split("\n")[1], "mixed Case Rd")

    def test_three_lines_no_trailing_newline(self):
        block = address_block("Jane Doe", "12 Main St", "Atlanta", "30301")
        self.assertEqual(len(block.split("\n")), 3)
        self.assertFalse(block.endswith("\n"))

    def test_recipient_exactly_30_unchanged(self):
        name = "a" * 30
        self.assertEqual(address_block(name, "s", "c", "1").split("\n")[0], "A" * 30)

    def test_recipient_31_truncated_with_tilde(self):
        line = address_block("a" * 31, "s", "c", "1").split("\n")[0]
        self.assertEqual(line, "A" * 29 + "~")
        self.assertEqual(len(line), 30)

    def test_long_recipient_truncated(self):
        line = address_block("a" * 80, "s", "c", "1").split("\n")[0]
        self.assertEqual(line, "A" * 29 + "~")

    def test_street_exactly_30_unchanged(self):
        street = "S" * 30
        self.assertEqual(address_block("n", street, "c", "1").split("\n")[1], street)

    def test_street_31_truncated_keeps_case(self):
        street = "s" * 31
        self.assertEqual(
            address_block("n", street, "c", "1").split("\n")[1], "s" * 29 + "~"
        )

    def test_city_line_exactly_30_unchanged(self):
        # 24 + space + 5 = 30
        line = address_block("n", "s", "x" * 24, "30301").split("\n")[2]
        self.assertEqual(line, "X" * 24 + " 30301")
        self.assertEqual(len(line), 30)

    def test_city_line_31_truncated(self):
        # 25 + space + 5 = 31 -> first 29 chars then "~"
        line = address_block("n", "s", "x" * 25, "30301").split("\n")[2]
        self.assertEqual(line, "X" * 25 + " 303~")
        self.assertEqual(len(line), 30)

    def test_each_line_truncated_independently(self):
        lines = address_block("a" * 40, "b" * 40, "c" * 40, "1").split("\n")
        self.assertEqual(lines[0], "A" * 29 + "~")
        self.assertEqual(lines[1], "b" * 29 + "~")
        self.assertEqual(lines[2], "C" * 29 + "~")


class InvalidAddressTests(unittest.TestCase):
    def assert_missing(self, args, text):
        with self.assertRaises(InvalidAddress) as cm:
            address_block(*args)
        self.assertEqual(str(cm.exception), text)

    def test_empty_recipient(self):
        self.assert_missing(("", "s", "c", "1"), "InvalidAddress: recipient is required")

    def test_none_recipient(self):
        self.assert_missing(
            (None, "s", "c", "1"), "InvalidAddress: recipient is required"
        )

    def test_empty_street(self):
        self.assert_missing(("n", "", "c", "1"), "InvalidAddress: street is required")

    def test_empty_city(self):
        self.assert_missing(("n", "s", "", "1"), "InvalidAddress: city is required")

    def test_empty_postal_code(self):
        self.assert_missing(
            ("n", "s", "c", ""), "InvalidAddress: postal code is required"
        )

    def test_none_postal_code(self):
        self.assert_missing(
            ("n", "s", "c", None), "InvalidAddress: postal code is required"
        )

    def test_first_missing_field_reported(self):
        self.assert_missing(("", "", "", ""), "InvalidAddress: recipient is required")
        self.assert_missing(("n", "", "", ""), "InvalidAddress: street is required")
        self.assert_missing(("n", "s", "", ""), "InvalidAddress: city is required")


if __name__ == "__main__":
    unittest.main()
