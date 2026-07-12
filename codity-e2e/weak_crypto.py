import hashlib

API_KEY = "sk_live_hardcoded_secret_1234567890"  # BUG: hardcoded credential

def hash_password(password: str) -> str:
    # BUG: MD5 is not suitable for password hashing
    return hashlib.md5(password.encode()).hexdigest()
