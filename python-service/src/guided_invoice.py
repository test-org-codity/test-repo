"""Invoice totals for a bulk order. All prices are in dollars."""

from decimal import Decimal, ROUND_HALF_UP

def invoice_total(lines, discount_percent=0):
    """Multiply unit price by quantity, then apply a percentage discount from 0 to 100."""
    discount = Decimal(str(discount_percent))
    if not discount.is_finite() or not Decimal("0") <= discount <= Decimal("100"):
        raise ValueError("discount_percent must be between 0 and 100")
    subtotal = Decimal("0")
    for line in lines:
        price = Decimal(str(line["unit_price"]))
        quantity = line["quantity"]
        if not price.is_finite() or price < 0 or isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
            raise ValueError("Each line needs a finite nonnegative price and an integer quantity")
        subtotal += price * quantity
    return float((subtotal * (Decimal("1") - discount / Decimal("100"))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
