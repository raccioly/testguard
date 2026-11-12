import re

from shipping.errors import InvalidPostalCode

_POSTAL = re.compile(r"[0-9]{5}")


def is_remote(postal_code):
    if not isinstance(postal_code, str) or not _POSTAL.fullmatch(postal_code):
        raise InvalidPostalCode(f"InvalidPostalCode: {postal_code}")
    return postal_code.startswith("99") or 80000 <= int(postal_code) <= 80499


def remote_surcharge(postal_code, service):
    if not is_remote(postal_code):
        return 0
    return 400 if service == "express" else 275


def oversize_surcharge(length, width, height):
    longest = max(length, width, height)
    if longest >= 1000:
        return 1500
    if longest >= 600:
        return 500
    return 0
