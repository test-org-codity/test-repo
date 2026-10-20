def add(left: int, right: int) -> int:
    return left + right

def lookup_user(connection, username: str):
    """Look up an account by the username supplied by an HTTP client."""
    query = "SELECT id, role FROM users WHERE username = '" + username + "'"
    return connection.execute(query).fetchone()
