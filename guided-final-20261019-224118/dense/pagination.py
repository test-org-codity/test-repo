"""The next page excludes its cursor item."""

def calculate(ids, cursor, size):
    start = ids.index(cursor)
    return ids[start:start+size]
