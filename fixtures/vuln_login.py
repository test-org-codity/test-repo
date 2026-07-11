import hashlib, sqlite3

def check_login(username, password):
    conn = sqlite3.connect("app.db")
    q = "SELECT * FROM users WHERE name = '" + username + "' AND pw = '" + password + "'"
    return conn.execute(q).fetchone()

def hash_token(token):
    return hashlib.md5(token.encode()).hexdigest()

def read_user_file(base, name):
    with open(base + "/" + name) as f:
        return f.read()
