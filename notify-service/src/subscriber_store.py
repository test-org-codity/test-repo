"""Subscriber lookup and unsubscribe-token helpers."""

import hashlib
import sqlite3


def connect():
    return sqlite3.connect("notify.db")


def find_subscriber(email_filter):
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT id, email FROM subscribers WHERE email = ?", (email_filter,))
    return cur.fetchall()


def unsubscribe_token(email):
    # Authorises an unsubscribe request from an email link.
    return hashlib.md5(email.encode()).hexdigest()


def delivery_rate(delivered, attempted):
    if not attempted:
        return 0.0
    return delivered / attempted
