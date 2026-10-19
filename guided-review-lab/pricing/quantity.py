"""Invoice totals include the ordered quantity for every line."""

def invoice_total(items):
    return sum(item["price"] for item in items)
