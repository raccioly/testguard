import unittest

from shipping import (
    InvalidParcel,
    ShippingError,
    billable_weight,
    dimensional_weight,
    validate_parcel,
)


def msg(field, low, high):
    return f"InvalidParcel: {field} must be between {low} and {high}"


class ValidateParcelRangeTests(unittest.TestCase):
    def assert_rejected(self, args, message):
        with self.assertRaises(InvalidParcel) as cm:
            validate_parcel(*args)
        self.assertEqual(str(cm.exception), message)

    def test_valid_parcel_returns_values(self):
        self.assertEqual(validate_parcel(100, 200, 300, 400), (100, 200, 300, 400))

    def test_minimum_boundaries_accepted(self):
        self.assertEqual(validate_parcel(10, 10, 10, 1), (10, 10, 10, 1))

    def test_maximum_boundaries_accepted(self):
        self.assertEqual(
            validate_parcel(1200, 1200, 1200, 30000), (1200, 1200, 1200, 30000)
        )

    def test_length_below_minimum(self):
        self.assert_rejected((9, 100, 100, 100), msg("length", 10, 1200))

    def test_length_above_maximum(self):
        self.assert_rejected((1201, 100, 100, 100), msg("length", 10, 1200))

    def test_width_below_minimum(self):
        self.assert_rejected((100, 9, 100, 100), msg("width", 10, 1200))

    def test_width_above_maximum(self):
        self.assert_rejected((100, 1201, 100, 100), msg("width", 10, 1200))

    def test_height_below_minimum(self):
        self.assert_rejected((100, 100, 9, 100), msg("height", 10, 1200))

    def test_height_above_maximum(self):
        self.assert_rejected((100, 100, 1201, 100), msg("height", 10, 1200))

    def test_weight_below_minimum(self):
        self.assert_rejected((100, 100, 100, 0), msg("weight", 1, 30000))

    def test_weight_above_maximum(self):
        self.assert_rejected((100, 100, 100, 30001), msg("weight", 1, 30000))

    def test_negative_values_rejected(self):
        self.assert_rejected((-5, 100, 100, 100), msg("length", 10, 1200))
        self.assert_rejected((100, 100, 100, -1), msg("weight", 1, 30000))

    def test_error_is_a_shipping_error(self):
        with self.assertRaises(ShippingError):
            validate_parcel(0, 100, 100, 100)


class ValidateParcelOrderTests(unittest.TestCase):
    def first_message(self, *args):
        with self.assertRaises(InvalidParcel) as cm:
            validate_parcel(*args)
        return str(cm.exception)

    def test_all_fields_bad_reports_length(self):
        self.assertEqual(self.first_message(0, 0, 0, 0), msg("length", 10, 1200))

    def test_width_reported_before_height_and_weight(self):
        self.assertEqual(self.first_message(100, 0, 0, 0), msg("width", 10, 1200))

    def test_height_reported_before_weight(self):
        self.assertEqual(self.first_message(100, 100, 0, 0), msg("height", 10, 1200))

    def test_weight_reported_last(self):
        self.assertEqual(self.first_message(100, 100, 100, 0), msg("weight", 1, 30000))

    def test_length_reported_even_when_only_length_and_weight_bad(self):
        self.assertEqual(self.first_message(5, 100, 100, 0), msg("length", 10, 1200))

    def test_non_integer_checked_in_field_order(self):
        self.assertEqual(
            self.first_message(100, "wide", 100, 10.5), msg("width", 10, 1200)
        )


class ValidateParcelNonIntegerTests(unittest.TestCase):
    def test_float_rejected(self):
        with self.assertRaises(InvalidParcel) as cm:
            validate_parcel(100.0, 100, 100, 100)
        self.assertEqual(str(cm.exception), msg("length", 10, 1200))

    def test_string_rejected(self):
        with self.assertRaises(InvalidParcel) as cm:
            validate_parcel(100, 100, 100, "500")
        self.assertEqual(str(cm.exception), msg("weight", 1, 30000))

    def test_none_rejected(self):
        with self.assertRaises(InvalidParcel) as cm:
            validate_parcel(100, 100, None, 100)
        self.assertEqual(str(cm.exception), msg("height", 10, 1200))

    def test_bool_rejected(self):
        # The source treats bool as a non-integer even though bool subclasses int.
        with self.assertRaises(InvalidParcel):
            validate_parcel(True, 100, 100, 100)
        with self.assertRaises(InvalidParcel):
            validate_parcel(100, 100, 100, True)


class DimensionalWeightTests(unittest.TestCase):
    def test_spec_example_exact_division(self):
        self.assertEqual(dimensional_weight(300, 200, 100), 1200)

    def test_spec_example_rounds_up(self):
        self.assertEqual(dimensional_weight(101, 101, 101), 207)

    def test_exact_multiple_is_not_rounded_up(self):
        self.assertEqual(dimensional_weight(50, 100, 100), 100)

    def test_minimum_parcel_rounds_up_to_one(self):
        self.assertEqual(dimensional_weight(10, 10, 10), 1)

    def test_one_gram_over_a_multiple_rounds_up(self):
        # 10 * 10 * 51 = 5100 -> 1.02 -> 2
        self.assertEqual(dimensional_weight(10, 10, 51), 2)

    def test_maximum_parcel(self):
        self.assertEqual(dimensional_weight(1200, 1200, 1200), 345600)

    def test_symmetric_in_dimensions(self):
        self.assertEqual(
            dimensional_weight(101, 202, 303), dimensional_weight(303, 101, 202)
        )


class BillableWeightTests(unittest.TestCase):
    def test_spec_actual_exceeds_dimensional(self):
        # actual 1200, dimensional 800 (200*200*100 / 5000) -> 1500
        self.assertEqual(dimensional_weight(200, 200, 100), 800)
        self.assertEqual(billable_weight(1200, 200, 200, 100), 1500)

    def test_spec_equal_weights_on_step(self):
        # actual 1000, dimensional 1000 (100*100*500 / 5000) -> 1000
        self.assertEqual(dimensional_weight(100, 100, 500), 1000)
        self.assertEqual(billable_weight(1000, 100, 100, 500), 1000)

    def test_spec_actual_1001_rounds_to_1500(self):
        self.assertEqual(billable_weight(1001, 10, 10, 10), 1500)

    def test_dimensional_dominates(self):
        # dimensional 1200 beats actual 100 -> 1500
        self.assertEqual(billable_weight(100, 300, 200, 100), 1500)

    def test_exact_step_not_rounded_up(self):
        self.assertEqual(billable_weight(500, 10, 10, 10), 500)
        self.assertEqual(billable_weight(1500, 10, 10, 10), 1500)

    def test_one_gram_rounds_to_first_step(self):
        self.assertEqual(billable_weight(1, 10, 10, 10), 500)

    def test_just_over_step_rounds_up(self):
        self.assertEqual(billable_weight(501, 10, 10, 10), 1000)

    def test_just_under_step_stays(self):
        self.assertEqual(billable_weight(499, 10, 10, 10), 500)

    def test_maximum_actual_weight(self):
        self.assertEqual(billable_weight(30000, 10, 10, 10), 30000)

    def test_dimensional_rounded_to_step(self):
        # dimensional 345600 -> next 500 g step is 346000
        self.assertEqual(billable_weight(1, 1200, 1200, 1200), 346000)


if __name__ == "__main__":
    unittest.main()
