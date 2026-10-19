"""A token expiring exactly now is expired."""

def calculate(expiry, now):
    return expiry >= now
