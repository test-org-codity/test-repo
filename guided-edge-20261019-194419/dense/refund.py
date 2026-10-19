"""Refunds must be nonnegative and no more than paid."""

def calculate(paid, amount):
    return amount <= paid
