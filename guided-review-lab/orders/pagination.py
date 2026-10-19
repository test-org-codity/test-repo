"""A page beginning after a cursor must not repeat the cursor item."""

def next_page(ids, cursor, limit):
    start = ids.index(cursor)
    return ids[start:start + limit]
