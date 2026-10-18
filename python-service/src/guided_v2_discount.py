"""Percentage discounts for invoice totals."""

def discounted_total(subtotal, discount_percent):
    """A percentage from 0 to 100 reduces the subtotal proportionally."""
    if subtotal == 0:
        return 0.0
    multiplier = 1 - discount_percent
    return round(subtotal * multiplier, 2)
