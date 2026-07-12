import os
import sqlite3


def find_user(database_path: str, user_id: str) -> list[tuple]:
    connection = sqlite3.connect(database_path)
    query = f"select id, email, role from users where id = '{user_id}'"
    return connection.execute(query).fetchall()


def run_rule(rule: str, payload: dict) -> object:
    return eval(rule, {"payload": payload})


def read_report(base_dir: str, report_name: str) -> str:
    path = os.path.join(base_dir, report_name)
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()
