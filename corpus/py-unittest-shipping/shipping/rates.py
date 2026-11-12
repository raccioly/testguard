from shipping.errors import ExpressWeightLimit, UnknownService, UnknownZone
from shipping.parcel import billable_weight, validate_parcel
from shipping.surcharges import oversize_surcharge, remote_surcharge

_EXTRA_STEP = {1: 60, 2: 90, 3: 140, 4: 210}
_SERVICES = ("standard", "express")


def _check_zone(zone):
    if isinstance(zone, bool) or not isinstance(zone, int) or zone not in _EXTRA_STEP:
        raise UnknownZone(f"UnknownZone: {zone}")


def _check_service(service):
    if service not in _SERVICES:
        raise UnknownService(f"UnknownService: {service}")


def _standard_base(billable, zone):
    steps = billable // 500
    return 450 + (steps - 1) * _EXTRA_STEP[zone]


def _base_rate(billable, zone, service):
    base = _standard_base(billable, zone)
    if service == "standard":
        return base
    if billable > 20000:
        raise ExpressWeightLimit("ExpressWeightLimit: 20000")
    # base * 1.75 rounded half up, in integer arithmetic
    return (base * 175 + 50) // 100 + 300


def quote(length, width, height, weight, zone, service, postal_code):
    """Itemized quote in cents: base, remote, oversize, total."""
    validate_parcel(length, width, height, weight)
    _check_zone(zone)
    _check_service(service)
    billable = billable_weight(weight, length, width, height)
    base = _base_rate(billable, zone, service)
    remote = remote_surcharge(postal_code, service)
    oversize = oversize_surcharge(length, width, height)
    return {
        "base": base,
        "remote": remote,
        "oversize": oversize,
        "total": base + remote + oversize,
    }
