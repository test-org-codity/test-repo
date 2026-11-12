import sqlite3

import pytest

from src.account_balance import balance_cents, cents_from_amount


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


@pytest.mark.parametrize("amount, expected", [(0.145, 15), (1.005, 101), (1.245, 125), (2.355, 236)])
def test_currency_conversion_rounds_decimal_half_cents_up(amount, expected):
    assert cents_from_amount(amount) == expected


@pytest.mark.parametrize("amount, expected", [(-0.145, -15), (-1.005, -101)])
def test_currency_conversion_rounds_negative_half_cents_away_from_zero(amount, expected):
    assert cents_from_amount(amount) == expected


@pytest.mark.parametrize(
    "amount",
    [float("nan"), float("inf"), float("-inf"), "not a number", "1e30", "1e999999999"],
)
def test_currency_conversion_rejects_invalid_amounts(amount):
    with pytest.raises(ValueError):
        cents_from_amount(amount)
