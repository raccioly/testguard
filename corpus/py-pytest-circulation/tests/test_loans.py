from datetime import date

import pytest

from circulation import Circulation, CirculationError, Loan

DUE_DAYS = {"book": 21, "tool": 7, "game": 14, "dvd": 7}


def test_tool_checked_out_2025_03_01_is_due_2025_03_08():
    loan = Circulation().create_loan("p1", "i1", "tool", "2025-03-01", "member")
    assert loan.due_date == date(2025, 3, 8)


@pytest.mark.parametrize(
    "item_type,expected_due",
    [
        ("book", date(2025, 3, 22)),
        ("tool", date(2025, 3, 8)),
        ("game", date(2025, 3, 15)),
        ("dvd", date(2025, 3, 8)),
    ],
)
def test_member_due_date_by_item_type(item_type, expected_due):
    loan = Circulation().create_loan("p1", "i1", item_type, "2025-03-01", "member")
    assert loan.due_date == expected_due
    assert loan.checkout_date == date(2025, 3, 1)


@pytest.mark.parametrize("item_type", ["book", "dvd"])
def test_guest_can_borrow_book_and_dvd(item_type):
    loan = Circulation().create_loan("g1", "i1", item_type, "2025-03-01", "guest")
    assert isinstance(loan, Loan)
    assert loan.patron_class == "guest"
    assert loan.due_date == date(2025, 3, 1).fromordinal(
        date(2025, 3, 1).toordinal() + DUE_DAYS[item_type]
    )


@pytest.mark.parametrize("item_type", ["tool", "game"])
def test_member_can_borrow_member_only_types(item_type):
    loan = Circulation().create_loan("m1", "i1", item_type, "2025-03-01", "member")
    assert loan.item_type == item_type
    assert loan.patron_class == "member"


@pytest.mark.parametrize("item_type", ["tool", "game"])
def test_guest_rejected_for_member_only_types(item_type):
    with pytest.raises(CirculationError) as exc:
        Circulation().create_loan("g1", "i1", item_type, "2025-03-01", "guest")
    assert exc.value.code == "NOT_ELIGIBLE"
    assert exc.value.message == "guests cannot borrow this item type"


@pytest.mark.parametrize("item_type", ["tool", "game"])
def test_rejected_guest_loan_is_not_recorded(item_type):
    circ = Circulation()
    with pytest.raises(CirculationError):
        circ.create_loan("g1", "i1", item_type, "2025-03-01", "guest")
    assert circ.active_loans("g1") == []


@pytest.mark.parametrize("item_type", ["magazine", "", "BOOK", "Book", "vinyl", "laptop"])
@pytest.mark.parametrize("patron_class", ["member", "guest"])
def test_unknown_item_type(item_type, patron_class):
    with pytest.raises(CirculationError) as exc:
        Circulation().create_loan("p1", "i1", item_type, "2025-03-01", patron_class)
    assert exc.value.code == "UNKNOWN_ITEM_TYPE"


def test_unknown_item_type_is_not_recorded():
    circ = Circulation()
    with pytest.raises(CirculationError):
        circ.create_loan("p1", "i1", "magazine", "2025-03-01", "member")
    assert circ.active_loans("p1") == []


@pytest.mark.parametrize(
    "bad_date",
    [
        "2025-02-30",
        "2025-02-29",
        "2025-13-01",
        "2025-00-10",
        "2025-04-31",
        "2025-01-00",
        "2025-3-1",
        "03/01/2025",
        "not a date",
        "",
        None,
        20250301,
    ],
)
@pytest.mark.parametrize("item_type", ["book", "tool", "game", "dvd"])
def test_invalid_checkout_date_for_every_item_type(bad_date, item_type):
    with pytest.raises(CirculationError) as exc:
        Circulation().create_loan("p1", "i1", item_type, bad_date, "member")
    assert exc.value.code == "INVALID_DATE"


def test_invalid_date_is_not_recorded():
    circ = Circulation()
    with pytest.raises(CirculationError):
        circ.create_loan("p1", "i1", "book", "2025-02-30", "member")
    assert circ.active_loans("p1") == []


def test_invalid_date_for_guest_book():
    with pytest.raises(CirculationError) as exc:
        Circulation().create_loan("g1", "i1", "book", "2025-02-30", "guest")
    assert exc.value.code == "INVALID_DATE"


def test_leap_day_checkout_is_valid():
    loan = Circulation().create_loan("p1", "i1", "tool", "2024-02-29", "member")
    assert loan.due_date == date(2024, 3, 7)


def test_date_object_accepted_as_checkout_date():
    loan = Circulation().create_loan("p1", "i1", "book", date(2025, 3, 1), "member")
    assert loan.due_date == date(2025, 3, 22)


def test_due_date_crosses_year_boundary():
    loan = Circulation().create_loan("p1", "i1", "book", "2025-12-20", "member")
    assert loan.due_date == date(2026, 1, 10)


def test_loan_records_ids_and_is_active():
    circ = Circulation()
    loan = circ.create_loan("p1", "item-9", "dvd", "2025-03-01", "member")
    assert loan.patron_id == "p1"
    assert loan.item_id == "item-9"
    assert circ.active_loans("p1") == [loan]


def test_default_patron_class_is_member():
    loan = Circulation().create_loan("p1", "i1", "tool", "2025-03-01")
    assert loan.patron_class == "member"
    assert loan.due_date == date(2025, 3, 8)
