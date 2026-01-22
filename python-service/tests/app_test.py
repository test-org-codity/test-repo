from flask import Flask, jsonify, request
from functools import wraps
import hashlib
import time

app = Flask(__name__)

# Simple in-memory cache
cache = {}
CACHE_TTL = 60  # seconds


def generate_cache_key(prefix: str, content: str) -> str:
    """Generate a deterministic cache key based on prefix and content."""
    hasher = hashlib.sha256()
    hasher.update(prefix.encode("utf-8"))
    hasher.update(b":")
    hasher.update(content.encode("utf-8"))
    return hasher.hexdigest()


def _get_request_content() -> str:
    """
    Safely extract the 'content' field from the JSON body.

    If JSON is missing or invalid, treat content as empty string.
    This avoids Werkzeug raising 415 when no/invalid JSON is sent.
    """
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}
    return data.get("content", "") or ""


def cached(prefix: str):
    """Decorator to cache JSON responses based on request 'content' field."""

    def decorator(view_func):
        @wraps(view_func)
        def wrapper(*args, **kwargs):
            content = _get_request_content()
            key = generate_cache_key(prefix, content)
            now = time.time()

            # Check cache
            entry = cache.get(key)
            if entry is not None and entry["expires_at"] > now:
                # Return cached response
                resp = jsonify({**entry["data"], "cached": True})
                return resp

            # Call underlying view
            result = view_func(*args, **kwargs)

            # Do not cache non-simple responses (e.g., (resp, status))
            if isinstance(result, tuple):
                return result

            resp = result
            data = resp.get_json() or {}

            # Store in cache
            cache[key] = {
                "data": data,
                "expires_at": now + CACHE_TTL,
            }

            # Mark as not cached
            return jsonify({**data, "cached": False})

        return wrapper

    return decorator


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy", "service": "python-reviewer"}), 200


# Dummy reviewer object to be patched in tests
class _Reviewer:
    def review_code(self, content: str, language: str):
        raise NotImplementedError

    def review_function(self, function_code: str):
        raise NotImplementedError


reviewer = _Reviewer()


@app.route("/review", methods=["POST"])
@cached("review")
def review_code():
    data = request.get_json(silent=True)
    if not data or "content" not in data:
        return jsonify({"error": "Missing 'content' field"}), 400

    content = data["content"]
    language = data.get("language", "python")

    result = reviewer.review_code(content, language)

    # Build JSON-serializable response from result object
    issues = [
        {
            "severity": issue.severity,
            "line": issue.line,
            "message": issue.message,
            "suggestion": issue.suggestion,
        }
        for issue in getattr(result, "issues", [])
    ]

    response = {
        "score": result.score,
        "issues": issues,
        "suggestions": list(getattr(result, "suggestions", [])),
        "complexity_score": getattr(result, "complexity_score", 0.0),
    }
    return jsonify(response)


@app.route("/review/function", methods=["POST"])
def review_function():
    data = request.get_json(silent=True)
    if not data or "function_code" not in data:
        return jsonify({"error": "Missing 'function_code' field"}), 400

    function_code = data["function_code"]
    result = reviewer.review_function(function_code)
    return jsonify(result)


@app.route("/cache/clear", methods=["POST"])
def clear_cache():
    cache.clear()
    return jsonify({"message": "Cache cleared successfully"}), 200


@app.route("/cache/stats", methods=["GET"])
def cache_stats():
    now = time.time()
    total = len(cache)
    active = 0
    expired = 0
    for entry in cache.values():
        if entry["expires_at"] > now:
            active += 1
        else:
            expired += 1
    return (
        jsonify(
            {
                "total_entries": total,
                "active_entries": active,
                "expired_entries": expired,
                "cache_ttl": CACHE_TTL,
            }
        ),
        200,
    )


if __name__ == "__main__":
    app.run(debug=True)