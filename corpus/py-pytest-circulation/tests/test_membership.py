from datetime import date

from circulation import renew_membership


def test_renewal_before_expiry_extends_from_expiry():
    assert renew_membership("standard", "2025-06-15", "2025-06-01") == date(2026, 6, 15)


def test_renewal_well_before_expiry_extends_from_expiry():
    assert renew_membership("basic", "2025-06-15", "2025-01-01") == date(2026, 6, 15)


def test_renewal_on_expiry_date_extends_from_expiry():
    assert renew_membership("plus", "2025-06-15", "2025-06-15") == date(2026, 6, 15)


def test_lapsed_renewal_extends_from_renewal_date():
    assert renew_membership("basic", "2025-01-10", "2025-03-05") == date(2026, 3, 5)


def test_renewal_one_day_after_expiry_is_lapsed():
    assert renew_membership("basic", "2025-06-15", "2025-06-16") == date(2026, 6, 16)


def test_feb_29_expiry_moves_to_feb_28():
    assert renew_membership("standard", "2024-02-29", "2024-02-01") == date(2025, 2, 28)


def test_feb_29_expiry_on_expiry_date_moves_to_feb_28():
    assert renew_membership("standard", "2024-02-29", "2024-02-29") == date(2025, 2, 28)


def test_lapsed_renewal_on_feb_29_moves_to_feb_28():
    assert renew_membership("basic", "2024-01-15", "2024-02-29") == date(2025, 2, 28)
