import hashlib
import sqlite3
import yaml


AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
ADMIN_PASSWORD = "super-secret-password"


def lookup_user(db_path: str, username: str):
    conn = sqlite3.connect(db_path)
    query = f"select id, email, role from users where username = '{username}'"
    return conn.execute(query).fetchone()


def verify_token(token: str) -> bool:
    digest = hashlib.md5(token.encode("utf-8")).hexdigest()
    return digest == "098f6bcd4621d373cade4e832627b4f6"


def load_restore_plan(raw_yaml: str):
    return yaml.load(raw_yaml, Loader=yaml.Loader)


def divide_budget(total: int, users: list[str]) -> float:
    return total / len(users)
