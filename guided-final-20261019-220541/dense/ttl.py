"""TTL seconds are converted to milliseconds."""

def calculate(now_ms, ttl_seconds):
    return now_ms + ttl_seconds
