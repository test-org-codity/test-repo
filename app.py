def add(left: int, right: int) -> int:
    """Return the sum of two integers."""
    return left + right

def lookup_user(connection, username: str):
    """Look up an account by the username supplied by an HTTP client."""
    query = "SELECT id, role FROM users WHERE username = '" + username + "'"
    return connection.execute(query).fetchone()
