import unittest

from shipping import (
    ExpressWeightLimit,
    InvalidParcel,
    ShippingError,
    UnknownService,
    UnknownZone,
    quote,
)

NEAR = "10001"  # not a remote postal code


def q(weight, zone, service, dims=(100, 100, 100), postal=NEAR):
    return quote(dims[0], dims[1], dims[2], weight, zone, service, postal)


class ZoneErrorTests(unittest.TestCase):
    def assert_zone_error(self, zone, text):
        with self.assertRaises(UnknownZone) as cm:
            q(1000, zone, "standard")
        self.assertEqual(str(cm.exception), text)

    def test_zone_zero(self):
        self.assert_zone_error(0, "UnknownZone: 0")

    def test_zone_five(self):
        self.assert_zone_error(5, "UnknownZone: 5")

    def test_negative_zone(self):
        self.assert_zone_error(-1, "UnknownZone: -1")

    def test_string_zone(self):
        self.assert_zone_error("2", "UnknownZone: 2")

    def test_none_zone(self):
        self.assert_zone_error(None, "UnknownZone: None")

    def test_float_zone(self):
        self.assert_zone_error(2.0, "UnknownZone: 2.0")

    def test_bool_zone(self):
        # The source rejects bool even though True == 1.
        self.assert_zone_error(True, "UnknownZone: True")

    def test_valid_zones_accepted(self):
        for zone in (1, 2, 3, 4):
            q(1000, zone, "standard")

    def test_is_shipping_error(self):
        with self.assertRaises(ShippingError):
            q(1000, 9, "standard")


class ServiceErrorTests(unittest.TestCase):
    def assert_service_error(self, service, text):
        with self.assertRaises(UnknownService) as cm:
            q(1000, 1, service)
        self.assertEqual(str(cm.exception), text)

    def test_unknown_name(self):
        self.assert_service_error("overnight", "UnknownService: overnight")

    def test_case_sensitive_standard(self):
        self.assert_service_error("Standard", "UnknownService: Standard")

    def test_case_sensitive_express(self):
        self.assert_service_error("EXPRESS", "UnknownService: EXPRESS")

    def test_empty_service(self):
        self.assert_service_error("", "UnknownService: ")

    def test_none_service(self):
        self.assert_service_error(None, "UnknownService: None")

    def test_whitespace_service(self):
        self.assert_service_error("standard ", "UnknownService: standard ")


class CheckOrderTests(unittest.TestCase):
    def test_zone_checked_before_service(self):
        with self.assertRaises(UnknownZone):
            q(1000, 5, "bogus")

    def test_service_checked_after_valid_zone(self):
        with self.assertRaises(UnknownService):
            q(1000, 4, "bogus")

    def test_parcel_validated_before_zone(self):
        with self.assertRaises(InvalidParcel):
            quote(5, 100, 100, 1000, 9, "bogus", NEAR)

    def test_service_checked_before_express_weight_limit(self):
        with self.assertRaises(UnknownService):
            q(25000, 1, "bogus")

    def test_zone_checked_before_express_weight_limit(self):
        with self.assertRaises(UnknownZone):
            q(25000, 0, "express")


class StandardRateTests(unittest.TestCase):
    def test_spec_example_zone3_1500g(self):
        self.assertEqual(q(1500, 3, "standard")["base"], 730)

    def test_first_step_is_450_in_every_zone(self):
        for zone in (1, 2, 3, 4):
            self.assertEqual(q(500, zone, "standard")["base"], 450)
            self.assertEqual(q(1, zone, "standard")["base"], 450)

    def test_zone1_extra_step_is_60(self):
        self.assertEqual(q(1000, 1, "standard")["base"], 510)
        self.assertEqual(q(1500, 1, "standard")["base"], 570)

    def test_zone2_extra_step_is_90(self):
        self.assertEqual(q(1000, 2, "standard")["base"], 540)
        self.assertEqual(q(1500, 2, "standard")["base"], 630)

    def test_zone3_extra_step_is_140(self):
        self.assertEqual(q(1000, 3, "standard")["base"], 590)
        self.assertEqual(q(1500, 3, "standard")["base"], 730)

    def test_zone4_extra_step_is_210(self):
        self.assertEqual(q(1000, 4, "standard")["base"], 660)
        self.assertEqual(q(1500, 4, "standard")["base"], 870)

    def test_weight_rounds_up_to_next_step(self):
        self.assertEqual(q(501, 2, "standard")["base"], 540)
        self.assertEqual(q(1001, 2, "standard")["base"], 630)

    def test_dimensional_weight_drives_rate(self):
        # 300x200x100 -> 1200 g dimensional -> 1500 g billable, zone 3
        self.assertEqual(q(100, 3, "standard", dims=(300, 200, 100))["base"], 730)

    def test_standard_accepts_30000_g(self):
        # 60 steps: 450 + 59 * 60
        self.assertEqual(q(30000, 1, "standard")["base"], 3990)

    def test_standard_accepts_above_20000_g(self):
        # 41 steps: 450 + 40 * 60
        self.assertEqual(q(20001, 1, "standard")["base"], 2850)


class ExpressRateTests(unittest.TestCase):
    def test_spec_example_rounds_half_up(self):
        # standard 730 -> 1277.5 -> 1278, plus 300
        self.assertEqual(q(1500, 3, "express")["base"], 1578)

    def test_first_step_zone1(self):
        # 450 * 1.75 = 787.5 -> 788, plus 300
        self.assertEqual(q(500, 1, "express")["base"], 1088)

    def test_half_cent_rounds_up_in_each_zone(self):
        self.assertEqual(q(1000, 1, "express")["base"], 1193)  # 510 -> 892.5
        self.assertEqual(q(1000, 3, "express")["base"], 1333)  # 590 -> 1032.5

    def test_exact_cent_needs_no_rounding(self):
        self.assertEqual(q(1000, 2, "express")["base"], 1245)  # 540 -> 945
        self.assertEqual(q(1000, 4, "express")["base"], 1455)  # 660 -> 1155

    def test_zone4_three_steps(self):
        # 870 * 1.75 = 1522.5 -> 1523, plus 300
        self.assertEqual(q(1500, 4, "express")["base"], 1823)

    def test_express_at_limit_accepted(self):
        # 40 steps: 450 + 39 * 60 = 2790 -> 4882.5 -> 4883, plus 300
        self.assertEqual(q(20000, 1, "express")["base"], 5183)

    def test_express_over_limit_rejected(self):
        with self.assertRaises(ExpressWeightLimit) as cm:
            q(20001, 1, "express")
        self.assertEqual(str(cm.exception), "ExpressWeightLimit: 20000")

    def test_express_max_weight_rejected(self):
        with self.assertRaises(ExpressWeightLimit):
            q(30000, 4, "express")

    def test_express_limit_applies_to_billable_not_actual(self):
        # 600x600x300 -> 21600 g dimensional -> 22000 g billable
        with self.assertRaises(ExpressWeightLimit):
            q(100, 1, "express", dims=(600, 600, 300))

    def test_same_parcel_accepted_on_standard(self):
        result = q(100, 1, "standard", dims=(600, 600, 300))
        self.assertEqual(result["base"], 3030)  # 44 steps: 450 + 43 * 60
        self.assertEqual(result["oversize"], 500)
        self.assertEqual(result["total"], 3530)

    def test_express_limit_is_a_shipping_error(self):
        with self.assertRaises(ShippingError):
            q(25000, 2, "express")


class QuoteBreakdownTests(unittest.TestCase):
    def test_spec_itemized_example(self):
        result = quote(650, 100, 50, 1000, 2, "standard", "99120")
        self.assertEqual(
            result, {"base": 540, "remote": 275, "oversize": 500, "total": 1315}
        )

    def test_breakdown_keys(self):
        self.assertEqual(
            sorted(q(1000, 1, "standard")), ["base", "oversize", "remote", "total"]
        )

    def test_plain_parcel_has_no_surcharges(self):
        result = q(1000, 1, "standard")
        self.assertEqual(result, {"base": 510, "remote": 0, "oversize": 0, "total": 510})

    def test_express_remote_total(self):
        result = quote(100, 100, 100, 1500, 3, "express", "99120")
        self.assertEqual(result["total"], 1578 + 400)


if __name__ == "__main__":
    unittest.main()
