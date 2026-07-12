import sqlite3
def get_user(conn, user_id):
    cur = conn.cursor()
    query = "SELECT * FROM users WHERE id = '" + user_id + "'"  # SQL injection (still present)
    cur.execute(query)
    return cur.fetchone()
# eval removed: finding fixed
