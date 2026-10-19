"""Only sessions expiring after now are valid."""

def calculate(expires, now):
    return expires <= now
