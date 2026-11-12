import re

from shipping.errors import InvalidAddress, InvalidSequence

_TRACKING = re.compile(r"BP[0-9]{9}[0-9]")
_WIDTH = 30


def _check_digit(digits):
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(digits))
    return total % 10


def tracking_number(sequence):
    if (
        isinstance(sequence, bool)
        or not isinstance(sequence, int)
        or not 0 <= sequence <= 999999999
    ):
        raise InvalidSequence(f"InvalidSequence: {sequence}")
    digits = f"{sequence:09d}"
    return f"BP{digits}{_check_digit(digits)}"


def verify_tracking(value):
    if not isinstance(value, str) or not _TRACKING.fullmatch(value):
        return False
    return int(value[11]) == _check_digit(value[2:11])


def _fit(line):
    return line if len(line) <= _WIDTH else line[: _WIDTH - 1] + "~"


def address_block(recipient, street, city, postal_code):
    fields = (
        ("recipient", recipient),
        ("street", street),
        ("city", city),
        ("postal code", postal_code),
    )
    for name, value in fields:
        if not value:
            raise InvalidAddress(f"InvalidAddress: {name} is required")
    lines = (recipient.upper(), street, f"{city.upper()} {postal_code}")
    return "\n".join(_fit(line) for line in lines)
