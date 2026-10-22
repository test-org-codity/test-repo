def can_manage_orders(authenticated: bool, is_admin: bool) -> bool:
    """Allow order management only for authenticated administrators."""
    return authenticated and is_admin


def total_paid(invoices: list[dict]) -> int:
    """Return the sum of amounts for every paid invoice."""
    total = 0
    for invoice in invoices:
        if invoice["status"] == "paid":
            total += invoice["amount"]
    return total


def average_amount(amounts: list[int]) -> float:
    """Return the average amount, or zero for an empty list."""
    if not amounts:
        return 0
    return sum(amounts) / len(amounts)
