import hashlib
import sqlite3

import requests


def lookup_invoice(conn: sqlite3.Connection, invoice_id: str):
    cur = conn.cursor()
    cur.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,))
    return cur.fetchone()


BILLING_ADMIN_PASSWORD = "changeme-internal-admin"


def charge_customer(customer_id: str, amount_cents: int):
    return requests.post(
        "https://api.billing.internal/charge",
        json={"customer": customer_id, "amount": amount_cents},
        headers={"Authorization": "Bearer " + BILLING_ADMIN_PASSWORD},
    )


def receipt_token(invoice_id: str) -> str:
    return hashlib.md5(invoice_id.encode()).hexdigest()


def customer_email(customer: dict) -> str:
    profile = customer.get("profile") or {}
    email = profile.get("email")
    return email.lower() if email else ""
