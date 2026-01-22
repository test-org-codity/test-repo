import hashlib
import time
from functools import wraps

from flask import Flask, jsonify, request

app = Flask(__name__)

# Simple in-memory cache structure:
# { cache_key: {"data": <response_json>, "expires_at": <timestamp>} }
cache = {}

# Time-to-live for cache entries in seconds
CACHE_TTL = 60


def generate_cache_key(prefix: str, data: str) -> str:
    """
    Generate a deterministic, prefix-sensitive SHA256-based cache key.

    The same prefix + data combination will always produce the same key.
    Different prefixes (even with identical data) will produce different keys.
    """
    hasher = hashlib.sha256()
    # Combine prefix and data in a way that changing either changes the hash.
    hasher.update(f"{prefix}:{data}".encode("utf-8"))
    return hasher.hexdigest()


def cached(prefix: str):
    """
    Decorator for caching Flask view responses based on request JSON 'content'.

    - Only caches non-tuple responses (i.e., normal Flask Response objects).
    - Adds a "cached" boolean field to the JSON body to indicate cache usage.
    - Respects CACHE_TTL for expiration.
    """

    def decorator(view_func):
        @wraps(view_func)
        def wrapper(*args, **kwargs):
            # Only attempt caching for JSON POST requests with 'content'
            req_json = request.get_json(silent=True) or {}
            content = req_json.get("content")
            if content is None:
                # If there's no 'content', just call the view directly
                return view_func(*args, **kwargs)

            key = generate_cache_key(prefix, content)
            now = time.time()
            entry = cache.get(key)

            if entry is not None and entry["expires_at"] > now:
                # Cache hit
                cached_data = dict(entry["data"])
                cached_data["cached"] = True
                return jsonify(cached_data)

            # Cache miss or expired
            result = view_func(*args, **kwargs)

            # Do not cache tuple responses (response, status, headers, etc.)
            if isinstance(result, tuple):
                return result

            # Expecting a Flask Response; extract JSON, augment, and store
            data = result.get_json() or {}
            data["cached"] = False

            cache[key] = {
                "data": data,
                "expires_at": now + CACHE_TTL,
            }

            return jsonify(data)

        return wrapper

    return decorator


@app.route("/health", methods=["GET"])
def health_check():
    """Simple health check endpoint."""
    return jsonify({"status": "healthy", "service": "python-reviewer"}), 200


# Placeholder reviewer instance to be patched in tests
class DummyReviewer:
    def review_code(self, content, language):
        return None

    def review_function(self, function_code):
        return None


reviewer = DummyReviewer()


@app.route("/review", methods=["POST"])
@cached("review")
def review_code():
    """
    Review arbitrary code. Expects JSON with:
    - 'content': code string (required)
    - 'language': optional language, defaults to 'python'
    """
    data = request.get_json(silent=True) or {}

    content = data.get("content")
    if content is None:
        return jsonify({"error": "Missing 'content' field"}), 400

    language = data.get("language", "python")

    result = reviewer.review_code(content, language)

    # Normalize the reviewer result into a JSON-serializable dict
    issues_list = []
    for issue in getattr(result, "issues", []):
        issues_list.append(
            {
                "severity": getattr(issue, "severity", None),
                "line": getattr(issue, "line", None),
                "message": getattr(issue, "message", None),
                "suggestion": getattr(issue, "suggestion", None),
            }
        )

    response_payload = {
        "score": getattr(result, "score", None),
        "issues": issues_list,
        "suggestions": list(getattr(result, "suggestions", [])),
        "complexity_score": getattr(result, "complexity_score", None),
    }
    # 'cached' flag is injected by the decorator; here we just return payload
    return jsonify(response_payload)


@app.route("/review/function", methods=["POST"])
def review_function():
    """
    Review a single function's code. Expects JSON with:
    - 'function_code': string (required)
    """
    data = request.get_json(silent=True) or {}
    function_code = data.get("function_code")
    if function_code is None:
        return jsonify({"error": "Missing 'function_code' field"}), 400

    result = reviewer.review_function(function_code)
    # Expect reviewer to return a JSON-serializable dict already
    return jsonify(result)


@app.route("/cache/clear", methods=["POST"])
def clear_cache():
    """Clear all cache entries."""
    cache.clear()
    return jsonify({"message": "Cache cleared successfully"})


@app.route("/cache/stats", methods=["GET"])
def cache_stats():
    """Return statistics about the current cache contents."""
    now = time.time()
    total = len(cache)
    active = 0
    expired = 0

    for entry in cache.values():
        if entry["expires_at"] > now:
            active += 1
        else:
            expired += 1

    return jsonify(
        {
            "total_entries": total,
            "active_entries": active,
            "expired_entries": expired,
            "cache_ttl": CACHE_TTL,
        }
    )


if __name__ == "__main__":
    app.run(debug=True)