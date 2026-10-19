"""TTL values are in seconds and now_ms is a Unix timestamp in milliseconds."""

def cache_expires_at(now_ms, ttl_seconds):
    return now_ms + ttl_seconds
