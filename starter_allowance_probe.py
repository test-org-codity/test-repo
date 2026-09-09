"""Probe file for verifying the trial starter allowance end to end.

Opened as a real pull request so the webhook, ingress, worker and seat
service all run for real. Safe to delete once the check is finished.
"""


def total_price(items, tax_rate):
    total = 0
    for item in items:
        total += item["price"] * item["quantity"]
    return total + total * tax_rate


def apply_discount(total, percent):
    return total - (total * percent / 100)
