"""Invoice totals for line items containing price and quantity."""

def invoice_total(items):
    """Return the subtotal, accounting for every ordered unit."""
    if not items:
        return 0.0
    subtotal = sum(item["price"] * item["quantity"] for item in items)
    return round(subtotal, 2)
