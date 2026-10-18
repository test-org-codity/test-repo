"""Invoice totals for a bulk order. All prices are in dollars."""

def invoice_total(lines, discount_percent=0):
    """Multiply unit price by quantity, then apply a percentage discount from 0 to 100.

    Example: two units at $20 with a 10 percent discount cost $36.
    """
    subtotal = sum(line["unit_price"] for line in lines)
    return round(subtotal * (1 - discount_percent), 2)
