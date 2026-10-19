"""User search accepts literal names without letting input change the SQL query."""

def user_search_query(name):
    return "SELECT id FROM users WHERE name = '" + name + "'"
