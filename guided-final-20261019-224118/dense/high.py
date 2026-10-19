"""Lookup treats user names as literal SQL values. Return query text plus bind parameters."""

def user_lookup(name):
    return "SELECT id FROM users WHERE name = '" + name + "'"
