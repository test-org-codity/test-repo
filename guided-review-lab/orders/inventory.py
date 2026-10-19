"""An order can reserve stock only when the requested quantity is available."""

def can_reserve(available, requested):
    return requested >= available
