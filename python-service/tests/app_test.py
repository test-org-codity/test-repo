import time
import hashlib
import pytest
from unittest.mock import Mock, patch

from src.app import (
    app,
    generate_cache_key,
    cached,
    health_check,
    review_code,
    review_function,
    clear_cache,
    cache_stats,
    cache,
    CACHE_TTL,
    reviewer,
)


@pytest.fixture
def client():
    """Provide a Flask test client with app context."""
    with app.test_client() as client:
        with app.app_context():
            yield client


@pytest.fixture(autouse=True)
def clear_global_cache():
    """Clear the global cache before each test."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def mock_time(monkeypatch):
    """Fixture to control time.time() for cache-related tests."""
    fake_time = [1000.0]

    def fake_time_func():
        return fake_time[0]

    monkeypatch.setattr(time, "time", fake_time_func)
    return fake_time


@pytest.mark.parametrize(
    "prefix,data",
    [
        ("review", "print('hello')"),
        ("review", ""),
        ("other", "some content"),
    ],
)
def test_generate_cache_key_deterministic(prefix, data):
    """Test that generate_cache_key is deterministic and uses SHA256."""
    key1 = generate_cache_key(prefix, data)
    key2 = generate_cache_key(prefix, data)
    assert key1 == key2
    assert isinstance(key1, str)
    assert len(key1) == 64
    expected = hashlib.sha256(f"{prefix}:{data}".encode()).hexdigest()
    assert key1 == expected


def test_generate_cache_key_different_inputs():
    """Test that different inputs produce different cache keys."""
    key1 = generate_cache_key("review", "a")
    key2 = generate_cache_key("review", "b")
    key3 = generate_cache_key("other", "a")
    assert key1 != key2
    assert key1 != key3
    assert key2 != key3


def test_cached_decorator_cache_miss_and_store(client, mock_time):
    """Test cached decorator on cache miss stores result and marks cached=False."""
    @app.route("/test_cached_miss", methods=["POST"])
    @cached("test")
    def test_endpoint():
        return jsonify({"result": "ok"})  # type: ignore[name-defined]

    from flask import jsonify  # local import to avoid circular issues

    with app.test_request_context(
        "/test_cached_miss", method="POST", json={"content": "code"}
    ):
        response = test_endpoint()
        data = response.get_json()
        assert data["result"] == "ok"
        assert data["cached"] is False
        assert len(cache) == 1
        entry = next(iter(cache.values()))
        assert entry["data"]["result"] == "ok"
        assert entry["expires_at"] == pytest.approx(mock_time[0] + CACHE_TTL)


def test_cached_decorator_cache_hit(client, mock_time):
    """Test cached decorator returns cached result with cached=True on hit."""
    from flask import jsonify

    @app.route("/test_cached_hit", methods=["POST"])
    @cached("testhit")
    def test_endpoint():
        return jsonify({"result": "fresh"})

    # First call to populate cache
    with app.test_request_context(
        "/test_cached_hit", method="POST", json={"content": "same"}
    ):
        response1 = test_endpoint()
        data1 = response1.get_json()
        assert data1["cached"] is False
        assert data1["result"] == "fresh"

    # Second call should hit cache
    with app.test_request_context(
        "/test_cached_hit", method="POST", json={"content": "same"}
    ):
        response2 = test_endpoint()
        data2 = response2.get_json()
        assert data2["cached"] is True
        assert data2["result"] == "fresh"
        assert len(cache) == 1


def test_cached_decorator_expired_entry(client, mock_time):
    """Test cached decorator evicts expired entries and recomputes."""
    from flask import jsonify

    @app.route("/test_cached_expire", methods=["POST"])
    @cached("testexpire")
    def test_endpoint():
        return jsonify({"value": mock_time[0]})

    # First call at time 1000
    with app.test_request_context(
        "/test_cached_expire", method="POST", json={"content": "x"}
    ):
        response1 = test_endpoint()
        data1 = response1.get_json()
        assert data1["cached"] is False
        first_value = data1["value"]

    # Advance time beyond TTL
    mock_time[0] += CACHE_TTL + 1

    # Second call should recompute and not be cached
    with app.test_request_context(
        "/test_cached_expire", method="POST", json={"content": "x"}
    ):
        response2 = test_endpoint()
        data2 = response2.get_json()
        assert data2["cached"] is False
        second_value = data2["value"]

    assert second_value != first_value
    assert len(cache) == 1


def test_cached_decorator_bypasses_cache_for_tuple_response(client):
    """Test cached decorator does not cache when view returns a tuple."""
    from flask import jsonify

    @app.route("/test_cached_tuple", methods=["POST"])
    @cached("tuple")
    def test_endpoint():
        return jsonify({"error": "bad"}), 400

    with app.test_request_context(
        "/test_cached_tuple", method="POST", json={"content": "x"}
    ):
        response = test_endpoint()
        assert isinstance(response, tuple)
        resp, status = response
        assert status == 400
        assert resp.get_json()["error"] == "bad"
        assert len(cache) == 0


def test_health_check_returns_expected_payload(client):
    """Test /health endpoint returns healthy status."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data == {"status": "healthy", "service": "python-reviewer"}


def test_review_code_missing_content_field(client):
    """Test /review returns 400 when 'content' field is missing."""
    response = client.post("/review", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'content' field"}


def test_review_code_no_json_body(client):
    """Test /review returns 400 when no JSON body is provided."""
    response = client.post("/review")
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'content' field"}


def _make_fake_review_result():
    """Helper to create a fake review result object."""
    issue1 = Mock()
    issue1.severity = "high"
    issue1.line = 10
    issue1.message = "Issue 1"
    issue1.suggestion = "Fix 1"

    issue2 = Mock()
    issue2.severity = "low"
    issue2.line = 20
    issue2.message = "Issue 2"
    issue2.suggestion = "Fix 2"

    result = Mock()
    result.score = 85
    result.issues = [issue1, issue2]
    result.suggestions = ["Use better names"]
    result.complexity_score = 3.5
    return result


def test_review_code_happy_path_default_language(client, monkeypatch):
    """Test /review with valid content and default language."""
    fake_result = _make_fake_review_result()
    monkeypatch.setattr(reviewer, "review_code", Mock(return_value=fake_result))

    payload = {"content": "print('hello')"}
    response = client.post("/review", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data["score"] == 85
    assert data["complexity_score"] == pytest.approx(3.5)
    assert data["suggestions"] == ["Use better names"]
    assert len(data["issues"]) == 2
    assert data["issues"][0]["severity"] == "high"
    assert data["issues"][0]["line"] == 10
    assert data["issues"][0]["message"] == "Issue 1"
    assert data["issues"][0]["suggestion"] == "Fix 1"
    reviewer.review_code.assert_called_once_with("print('hello')", "python")


def test_review_code_happy_path_with_language(client, monkeypatch):
    """Test /review with explicit language parameter."""
    fake_result = _make_fake_review_result()
    monkeypatch.setattr(reviewer, "review_code", Mock(return_value=fake_result))

    payload = {"content": "console.log('hi')", "language": "javascript"}
    response = client.post("/review", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data["score"] == 85
    reviewer.review_code.assert_called_once_with("console.log('hi')", "javascript")


def test_review_code_caching_behavior(client, monkeypatch):
    """Test /review endpoint caching behavior via decorator."""
    fake_result = _make_fake_review_result()
    mock_review = Mock(return_value=fake_result)
    monkeypatch.setattr(reviewer, "review_code", mock_review)

    payload = {"content": "print('cache test')"}
    response1 = client.post("/review", json=payload)
    data1 = response1.get_json()
    assert response1.status_code == 200
    assert data1["cached"] is False

    response2 = client.post("/review", json=payload)
    data2 = response2.get_json()
    assert response2.status_code == 200
    assert data2["cached"] is True

    mock_review.assert_called_once()


def test_review_function_missing_function_code(client):
    """Test /review/function returns 400 when 'function_code' is missing."""
    response = client.post("/review/function", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'function_code' field"}


def test_review_function_no_json_body(client):
    """Test /review/function returns 400 when no JSON body is provided."""
    response = client.post("/review/function")
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'function_code' field"}


def test_review_function_happy_path(client, monkeypatch):
    """Test /review/function with valid function_code."""
    fake_response = {"quality": "good", "issues": []}
    monkeypatch.setattr(reviewer, "review_function", Mock(return_value=fake_response))

    payload = {"function_code": "def foo(): pass"}
    response = client.post("/review/function", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data == fake_response
    reviewer.review_function.assert_called_once_with("def foo(): pass")


def test_clear_cache_empties_cache(client):
    """Test /cache/clear empties the global cache."""
    cache["a"] = {"data": {"x": 1}, "expires_at": time.time() + 100}
    cache["b"] = {"data": {"y": 2}, "expires_at": time.time() - 100}
    assert len(cache) == 2

    response = client.post("/cache/clear")
    assert response.status_code == 200
    data = response.get_json()
    assert data == {"message": "Cache cleared successfully"}
    assert len(cache) == 0


def test_cache_stats_with_mixed_entries(client, mock_time):
    """Test /cache/stats reports correct counts for active and expired entries."""
    cache["active1"] = {"data": {"a": 1}, "expires_at": mock_time[0] + 10}
    cache["active2"] = {"data": {"b": 2}, "expires_at": mock_time[0] + 5}
    cache["expired1"] = {"data": {"c": 3}, "expires_at": mock_time[0] - 1}

    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 3
    assert data["active_entries"] == 2
    assert data["expired_entries"] == 1
    assert data["cache_ttl"] == CACHE_TTL


def test_cache_stats_with_no_entries(client):
    """Test /cache/stats when cache is empty."""
    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 0
    assert data["active_entries"] == 0
    assert data["expired_entries"] == 0
    assert data["cache_ttl"] == CACHE_TTL


def test_cached_decorator_uses_content_empty_when_no_json(client):
    """Test cached decorator handles requests without JSON body gracefully."""
    from flask import jsonify

    @app.route("/test_cached_no_json", methods=["POST"])
    @cached("noj")
    def test_endpoint():
        return jsonify({"ok": True})

    with app.test_request_context("/test_cached_no_json", method="POST"):
        response = test_endpoint()
        data = response.get_json()
        assert data["ok"] is True
        assert data["cached"] is False
        assert len(cache) == 1

    with app.test_request_context("/test_cached_no_json", method="POST"):
        response2 = test_endpoint()
        data2 = response2.get_json()
        assert data2["cached"] is True
        assert len(cache) == 1