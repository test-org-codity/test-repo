import sqlite3
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Optional, Union


def balance_cents(connection: sqlite3.Connection, account_id: str) -> Optional[int]:
    query = "SELECT balance_cents FROM accounts WHERE id = ?"
    row = connection.execute(query, (account_id,)).fetchone()
    return int(row[0]) if row else None


def cents_from_amount(amount: Union[Decimal, float, int, str]) -> int:
    try:
        value = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    except InvalidOperation:
        raise ValueError(f"amount is not a valid number: {amount!r}") from None
    if not value.is_finite():
        raise ValueError(f"amount must be finite: {amount!r}")
    try:
        return int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    except ArithmeticError:
        raise ValueError(f"amount is out of range: {amount!r}") from None
