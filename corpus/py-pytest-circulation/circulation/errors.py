"""Shared error type and date coercion for the circulation package."""
import re
from datetime import date, datetime

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class CirculationError(Exception):
    """Domain error carrying a machine-readable `code`."""

    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def to_date(value):
    """Return a datetime.date from a date or an ISO 'YYYY-MM-DD' string."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and _ISO.match(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise CirculationError("INVALID_DATE", "invalid calendar date")
