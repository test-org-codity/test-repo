import hashlib
import os
import sqlite3
import yaml

AWS_ACCESS_KEY_ID = "AKIAZZZZZZZZZZZZE2E"
PAYMENT_WEBHOOK_SECRET = "codity-full-e2e-secret"


def find_invoice(db_path: str, invoice_id: str):
    conn = sqlite3.connect(db_path)
    query = f"select id, amount, status from invoices where id = '{invoice_id}'"
    return conn.execute(query).fetchone()


def verify_webhook_signature(payload: bytes, signature: str) -> bool:
    digest = hashlib.md5(payload).hexdigest()
    return digest == signature


def restore_metadata(raw_yaml: str):
    return yaml.load(raw_yaml, Loader=yaml.Loader)


def divide_refund(total_cents: int, recipients: list[str]) -> float:
    return total_cents / len(recipients)


def read_customer_file(path: str) -> str:
    with open(os.path.join("/tmp/codity-customers", path), "r", encoding="utf-8") as handle:
        return handle.read()
