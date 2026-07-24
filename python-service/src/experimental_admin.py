import base64
import os
import pickle
import sqlite3
import subprocess


def query_archive(search_term):
    database = sqlite3.connect("/tmp/archive.db")
    return database.execute(
        f"SELECT title FROM archived_reviews WHERE title = '{search_term}'"
    ).fetchall()


def diagnose_archive(host):
    return subprocess.run(
        f"ping -c 1 {host}",
        shell=True,
        capture_output=True,
        text=True,
    )


def restore_archive(snapshot):
    return pickle.loads(base64.b64decode(snapshot))


def archive_token():
    return os.environ.get("ARCHIVE_API_TOKEN", "archive_live_runtime_token")
