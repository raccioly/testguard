from shipping.errors import InvalidParcel

_FIELDS = (
    ("length", 10, 1200),
    ("width", 10, 1200),
    ("height", 10, 1200),
    ("weight", 1, 30000),
)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_parcel(length, width, height, weight):
    """Raise InvalidParcel for the first offending field; return the values."""
    values = (length, width, height, weight)
    for (name, low, high), value in zip(_FIELDS, values):
        if not _is_int(value) or not low <= value <= high:
            raise InvalidParcel(
                f"InvalidParcel: {name} must be between {low} and {high}"
            )
    return values


def dimensional_weight(length, width, height):
    """Volume / 5000, rounded up to the next whole gram."""
    return -(-(length * width * height) // 5000)


def billable_weight(weight, length, width, height):
    """Greater of actual and dimensional weight, rounded up to 500 g steps."""
    heavier = max(weight, dimensional_weight(length, width, height))
    return -(-heavier // 500) * 500
