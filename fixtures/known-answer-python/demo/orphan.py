"""A module no test imports. It exists to prove TestGuard says so."""


def is_allowed(role):
    return role == "admin"
