import pathlib

import pytest

from circulation import CirculationError, compute_late_fee

COUNTER = pathlib.Path(__file__).with_name(".fee_rotation")

GRACE = {"member": 3, "guest": 0}
CAP = {"member": 1500, "guest": 1000}
RATE = {
    "member": {"book": 10, "dvd": 10, "tool": 25, "game": 25},
    "guest": {"book": 20, "dvd": 20, "tool": 50, "game": 50},
}
DUE = "2025-03-01"


def _return_after(days):
    from datetime import date, timedelta

    return date(2025, 3, 1) + timedelta(days=days)


@pytest.fixture(scope="module")
def patron_class():
    try:
        value = int(COUNTER.read_text().strip())
    except (FileNotFoundError, ValueError):
        value = 0
    COUNTER.write_text(str(value + 1))
    return "member" if value % 2 == 0 else "guest"


def _expected(patron_class, item_type, days_late):
    if days_late <= 0:
        return 0
    billable = max(0, days_late - GRACE[patron_class])
    return min(billable * RATE[patron_class][item_type], CAP[patron_class])


def test_on_time_return_is_free(patron_class):
    assert compute_late_fee(DUE, DUE, "book", patron_class) == 0


def test_early_return_is_free(patron_class):
    assert compute_late_fee(DUE, "2025-02-20", "tool", patron_class) == 0


def test_one_day_late(patron_class):
    expected = _expected(patron_class, "book", 1)
    assert expected == (0 if patron_class == "member" else 20)
    assert compute_late_fee(DUE, _return_after(1), "book", patron_class) == expected


def test_grace_boundary_three_days_late(patron_class):
    expected = 0 if patron_class == "member" else 3 * 20
    assert compute_late_fee(DUE, _return_after(3), "book", patron_class) == expected


def test_first_billable_day_for_member_is_day_four(patron_class):
    expected = 10 if patron_class == "member" else 4 * 20
    assert compute_late_fee(DUE, _return_after(4), "book", patron_class) == expected


def test_five_days_late(patron_class):
    expected = 2 * 10 if patron_class == "member" else 5 * 20
    assert compute_late_fee(DUE, _return_after(5), "book", patron_class) == expected


@pytest.mark.parametrize("item_type", ["book", "dvd", "tool", "game"])
def test_daily_rate_for_each_item_type(patron_class, item_type):
    days_late = 10
    expected = _expected(patron_class, item_type, days_late)
    billable = days_late - GRACE[patron_class]
    assert expected == billable * RATE[patron_class][item_type]
    assert compute_late_fee(DUE, _return_after(days_late), item_type, patron_class) == expected


def test_guest_game_four_days_example_or_member_equivalent(patron_class):
    expected = 4 * 50 if patron_class == "guest" else 1 * 25
    assert compute_late_fee(DUE, _return_after(4), "game", patron_class) == expected


@pytest.mark.parametrize("item_type", ["book", "dvd", "tool", "game"])
def test_cap_applies_to_every_item_type(patron_class, item_type):
    cap = 1500 if patron_class == "member" else 1000
    assert compute_late_fee(DUE, _return_after(1000), item_type, patron_class) == cap


def test_cap_example_from_spec(patron_class):
    if patron_class == "member":
        assert compute_late_fee(DUE, _return_after(100), "tool", "member") == 1500
    else:
        assert compute_late_fee(DUE, _return_after(100), "book", "guest") == 1000


def test_fee_just_below_cap_is_not_capped(patron_class):
    # Pick days so the uncapped fee is just under the cap for a tool.
    rate = RATE[patron_class]["tool"]
    billable = CAP[patron_class] // rate - 1
    days_late = billable + GRACE[patron_class]
    expected = billable * rate
    assert expected < CAP[patron_class]
    assert compute_late_fee(DUE, _return_after(days_late), "tool", patron_class) == expected


def test_fee_exactly_at_cap(patron_class):
    rate = RATE[patron_class]["tool"]
    billable = CAP[patron_class] // rate
    days_late = billable + GRACE[patron_class]
    assert billable * rate == CAP[patron_class]
    assert compute_late_fee(DUE, _return_after(days_late), "tool", patron_class) == CAP[patron_class]


def test_fee_is_integer_cents(patron_class):
    fee = compute_late_fee(DUE, _return_after(9), "game", patron_class)
    assert isinstance(fee, int)


def test_invalid_patron_class_rejected(patron_class):
    with pytest.raises(CirculationError) as exc:
        compute_late_fee(DUE, _return_after(10), "book", "staff")
    assert exc.value.code == "INVALID_PATRON_CLASS"
