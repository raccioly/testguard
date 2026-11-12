class ShippingError(Exception):
    """Base class for all Brindle Post errors."""


class InvalidParcel(ShippingError):
    pass


class UnknownZone(ShippingError):
    pass


class UnknownService(ShippingError):
    pass


class ExpressWeightLimit(ShippingError):
    pass


class InvalidPostalCode(ShippingError):
    pass


class InvalidSequence(ShippingError):
    pass


class InvalidAddress(ShippingError):
    pass
