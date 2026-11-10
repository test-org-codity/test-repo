import sqlite3

import pytest

from src.account_balance import balance_cents


@pytest.fixture
def accounts():
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE accounts (id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL)")
    connection.executemany("INSERT INTO accounts VALUES (?, ?)", [("alice", 12545), ("o'brien", 301)])
    try:
        yield connection
    finally:
        connection.close()


def test_balance_preserves_integer_cents(accounts):
    result = balance_cents(accounts, "alice")
    assert type(result) is int
    assert result == 12545


def test_missing_account_returns_none(accounts):
    assert balance_cents(accounts, "missing") is None


def test_quoted_account_id_is_opaque(accounts):
    assert balance_cents(accounts, "o'brien") == 301


def test_sql_expression_does_not_match_another_account(accounts):
    assert balance_cents(accounts, "' OR '1'='1") is None
