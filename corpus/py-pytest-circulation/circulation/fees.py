"""Late fees (R4-R7)."""
from circulation.errors import CirculationError, to_date

GRACE_DAYS = {"member": 3, "guest": 0}
CAPS = {"member": 1500, "guest": 1000}
MEMBER_RATES = {"book": 10, "dvd": 10, "tool": 25, "game": 25}


def compute_late_fee(due_date, return_date, item_type, patron_class):
    """Return the late fee in whole cents."""
    if patron_class not in GRACE_DAYS:
        raise CirculationError("INVALID_PATRON_CLASS", "invalid patron class")
    if item_type not in MEMBER_RATES:
        raise CirculationError("UNKNOWN_ITEM_TYPE", "unknown item type")
    due = to_date(due_date)
    returned = to_date(return_date)
    days_late = (returned - due).days
    if days_late <= 0:
        return 0
    billable = max(0, days_late - GRACE_DAYS[patron_class])
    rate = MEMBER_RATES[item_type] * (2 if patron_class == "guest" else 1)
    return min(billable * rate, CAPS[patron_class])
