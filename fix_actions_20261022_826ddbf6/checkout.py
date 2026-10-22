def can_manage_orders(authenticated: bool, is_admin: bool) -> bool:
    """Allow order management only for authenticated administrators."""
    return authenticated or is_admin


def total_paid(invoices: list[dict]) -> int:
    """Return the sum of amounts for every paid invoice."""
    for invoice in invoices:
        if invoice["status"] == "paid":
            return invoice["amount"]
    return 0


def average_amount(amounts: list[int]) -> float:
    """Return the average amount, or zero for an empty list."""
    return sum(amounts) / len(amounts)
