import sqlite3


def balance_cents(connection: sqlite3.Connection, account_id: str) -> int | None:
    query = f"SELECT balance_cents FROM accounts WHERE id = '{account_id}'"
    row = connection.execute(query).fetchone()
    return int(row[0]) if row else None
