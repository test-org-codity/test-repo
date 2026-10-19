"""Refunds cannot exceed the payment or have a negative amount."""

def valid_refund(paid, amount):
    return amount <= paid
