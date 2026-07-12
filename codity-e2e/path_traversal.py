import os

BASE_DIR = "/var/www/uploads"

def read_file(filename: str) -> bytes:
    # BUG: path traversal, filename is not sanitized
    full = os.path.join(BASE_DIR, filename)
    with open(full, "rb") as f:
        return f.read()
