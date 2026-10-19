"""Limits are capped at the configured maximum."""

def calculate(requested, maximum):
    return min(requested, maximum)
