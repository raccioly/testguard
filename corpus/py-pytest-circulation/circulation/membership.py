"""Membership tiers and renewal (R11-R13)."""
from datetime import timedelta

from circulation.errors import CirculationError, to_date

ANNUAL_FEES = {"basic": 1000, "standard": 2500, "plus": 4000}
EARLY_WINDOW_DAYS = 30


def _check_tier(tier):
    if tier not in ANNUAL_FEES:
        raise CirculationError("INVALID_TIER", "invalid membership tier")


def _add_year(d):
    try:
        return d.replace(year=d.year + 1)
    except ValueError:  # 29 February -> 28 February
        return d.replace(year=d.year + 1, day=28)


def renew_membership(tier, expiry_date, renewal_date):
    """Return the new expiry date."""
    _check_tier(tier)
    expiry = to_date(expiry_date)
    renewal = to_date(renewal_date)
    return _add_year(expiry if renewal <= expiry else renewal)


def renewal_fee(tier, expiry_date, renewal_date):
    """Return the renewal fee in cents (10% early-renewal discount, rounded down)."""
    _check_tier(tier)
    expiry = to_date(expiry_date)
    renewal = to_date(renewal_date)
    fee = ANNUAL_FEES[tier]
    if expiry - timedelta(days=EARLY_WINDOW_DAYS) <= renewal <= expiry:
        return fee * 90 // 100
    return fee
