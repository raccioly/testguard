"""Loans and due dates (R1-R3)."""
from dataclasses import dataclass
from datetime import date, timedelta

from circulation.errors import CirculationError, to_date

LOAN_DAYS = {"book": 21, "tool": 7, "game": 14, "dvd": 7}
MEMBER_ONLY = {"tool", "game"}
LOAN_LIMITS = {"member": 5, "guest": 2}


@dataclass
class Loan:
    patron_id: str
    item_id: str
    item_type: str
    patron_class: str
    checkout_date: date
    due_date: date


class Circulation:
    """Tracks active loans per patron."""

    def __init__(self):
        self._loans = []

    def active_loans(self, patron_id):
        return [loan for loan in self._loans if loan.patron_id == patron_id]

    def create_loan(self, patron_id, item_id, item_type, checkout_date,
                    patron_class="member"):
        if patron_class not in LOAN_LIMITS:
            raise CirculationError("INVALID_PATRON_CLASS", "invalid patron class")
        if item_type not in LOAN_DAYS:
            raise CirculationError("UNKNOWN_ITEM_TYPE", "unknown item type")
        checkout = to_date(checkout_date)
        if patron_class == "guest" and item_type in MEMBER_ONLY:
            raise CirculationError("NOT_ELIGIBLE", "guests cannot borrow this item type")
        if len(self.active_loans(patron_id)) >= LOAN_LIMITS[patron_class]:
            raise CirculationError("LOAN_LIMIT_REACHED", "loan limit reached")
        loan = Loan(patron_id, item_id, item_type, patron_class, checkout,
                    checkout + timedelta(days=LOAN_DAYS[item_type]))
        self._loans.append(loan)
        return loan

    def return_loan(self, patron_id, item_id):
        """Remove an active loan; returns it, or None if there was none."""
        for loan in self._loans:
            if loan.patron_id == patron_id and loan.item_id == item_id:
                self._loans.remove(loan)
                return loan
        return None
