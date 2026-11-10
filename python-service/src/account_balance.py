import sqlite3
from typing import Optional


def balance_cents(connection: sqlite3.Connection, account_id: str) -> Optional[int]:
    query = "SELECT balance_cents FROM accounts WHERE id = ?"
    row = connection.execute(query, (account_id,)).fetchone()
    return int(row[0]) if row else None


def cents_from_amount(amount: float) -> int:
    return round(amount * 100)
