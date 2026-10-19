"""An expired session cannot authenticate a request."""

def session_valid(expires_at, now):
    return expires_at <= now
