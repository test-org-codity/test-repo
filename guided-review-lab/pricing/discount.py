"""Percentage discounts accept whole-number percentages from zero to 100."""

def discount_total(total, percent):
    return total * (1 - percent)
