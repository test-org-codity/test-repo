import pytest
from unittest.mock import Mock, patch
from flask import json

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
)


@pytest.fixture
def client():
    """Provide a Flask test client with app context."""
    with app.test_client() as client:
        with app.app_context():
            yield client


@pytest.fixture(autouse=True)
def clear_cache_before_after():
    """Clear global cache before and after each test."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def mock_time(monkeypatch):
    """Mock time.time to control TTL behavior."""
    current_time = 1000.0

    def fake_time():
        return current_time

    monkeypatch.setattr("src.app.time.time", fake_time)
    return lambda new_time: setattr(fake_time, "__wrapped__", new_time)


@pytest.mark.parametrize(
    "prefix,data1,data2,should_match",
    [
        ("p1", "same", "same", True),
        ("p1", "a", "b", False),
        ("p1", "x", "x ", False),
        ("p1", "", "", True),
        ("p1", "content", "content", True),
        ("p2", "content", "content", False),
    ],
)
def test_generate_cache_key_deterministic_and_prefix_sensitive(prefix, data1, data2, should_match):
    """Test generate_cache_key produces deterministic and prefix-sensitive keys."""
    key1 = generate_cache_key(prefix, data1)
    key2 = generate_cache_key(prefix, data2)
    if should_match:
        assert key1 == key2
    else:
        assert key1 != key2


def test_cached_decorator_caches_successful_response(client, monkeypatch):
    """Test cached decorator caches JSON responses and adds cached flag."""
    calls = {"count": 0}

    @cached("test")
    def test_view():
        calls["count"] += 1
        return json.jsonify({"value": 42})

    with app.test_request_context(json={"content": "abc"}):
        resp1 = test_view()
        data1 = resp1.get_json()
        assert data1["value"] == 42
        assert data1["cached"] is False
        assert calls["count"] == 1

    with app.test_request_context(json={"content": "abc"}):
        resp2 = test_view()
        data2 = resp2.get_json()
        assert data2["value"] == 42
        assert data2["cached"] is True
        assert calls["count"] == 1

    with app.test_request_context(json={"content": "different"}):
        resp3 = test_view()
        data3 = resp3.get_json()
        assert data3["value"] == 42
        assert data3["cached"] is False
        assert calls["count"] == 2


def test_cached_decorator_skips_caching_for_tuple_response(client):
    """Test cached decorator does not cache when view returns a tuple (response, status)."""
    calls = {"count": 0}

    @cached("test")
    def test_view():
        calls["count"] += 1
        return json.jsonify({"value": 1}), 201

    with app.test_request_context(json={"content": "abc"}):
        resp1, status1 = test_view()
        assert status1 == 201
        assert resp1.get_json() == {"value": 1}
        assert calls["count"] == 1

    with app.test_request_context(json={"content": "abc"}):
        resp2, status2 = test_view()
        assert status2 == 201
        assert resp2.get_json() == {"value": 1}
        assert calls["count"] == 2

    assert len(cache) == 0


def test_cached_decorator_handles_missing_json(client):
    """Test cached decorator works when request JSON is missing."""
    calls = {"count": 0}

    @cached("test")
    def test_view():
        calls["count"] += 1
        return json.jsonify({"value": 99})

    with app.test_request_context():
        resp1 = test_view()
        data1 = resp1.get_json()
        assert data1["value"] == 99
        assert data1["cached"] is False
        assert calls["count"] == 1

    with app.test_request_context():
        resp2 = test_view()
        data2 = resp2.get_json()
        assert data2["value"] == 99
        assert data2["cached"] is True
        assert calls["count"] == 1


def test_cached_decorator_expires_entries(monkeypatch, client):
    """Test cached decorator invalidates expired cache entries based on TTL."""
    base_time = 1000.0

    def fake_time():
        return base_time

    monkeypatch.setattr("src.app.time.time", lambda: fake_time())

    calls = {"count": 0}

    @cached("test")
    def test_view():
        calls["count"] += 1
        return json.jsonify({"value": 7})

    with app.test_request_context(json={"content": "abc"}):
        resp1 = test_view()
        data1 = resp1.get_json()
        assert data1["cached"] is False
        assert calls["count"] == 1

    monkeypatch.setattr("src.app.time.time", lambda: base_time + CACHE_TTL + 1)

    with app.test_request_context(json={"content": "abc"}):
        resp2 = test_view()
        data2 = resp2.get_json()
        assert data2["cached"] is False
        assert calls["count"] == 2


def test_health_check_returns_expected_payload(client):
    """Test /health endpoint returns healthy status and service name."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "healthy"
    assert data["service"] == "python-reviewer"


def test_review_code_missing_content_field_returns_400(client):
    """Test /review returns 400 when 'content' field is missing."""
    response = client.post("/review", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data["error"] == "Missing 'content' field"


def test_review_code_no_json_returns_400(client):
    """Test /review returns 400 when no JSON body is provided."""
    response = client.post("/review")
    assert response.status_code == 400
    data = response.get_json()
    assert data["error"] == "Missing 'content' field"


def test_review_code_happy_path_uses_default_language_and_caches(client):
    """Test /review happy path with default language and caching behavior."""
    mock_result = Mock()
    mock_result.score = 85
    mock_result.issues = [
        Mock(severity="high", line=10, message="Issue 1", suggestion="Fix 1"),
        Mock(severity="low", line=20, message="Issue 2", suggestion="Fix 2"),
    ]
    mock_result.suggestions = ["Suggestion 1", "Suggestion 2"]
    mock_result.complexity_score = 3.5

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_code.return_value = mock_result

        response1 = client.post("/review", json={"content": "print('hi')"})
        assert response1.status_code == 200
        data1 = response1.get_json()
        assert data1["score"] == 85
        assert data1["complexity_score"] == pytest.approx(3.5)
        assert len(data1["issues"]) == 2
        assert data1["issues"][0]["severity"] == "high"
        assert data1["issues"][0]["line"] == 10
        assert data1["issues"][0]["message"] == "Issue 1"
        assert data1["issues"][0]["suggestion"] == "Fix 1"
        assert data1["suggestions"] == ["Suggestion 1", "Suggestion 2"]
        assert data1["cached"] is False

        response2 = client.post("/review", json={"content": "print('hi')"})
        assert response2.status_code == 200
        data2 = response2.get_json()
        assert data2["score"] == 85
        assert data2["cached"] is True

        assert mock_reviewer.review_code.call_count == 1
        mock_reviewer.review_code.assert_called_with("print('hi')", "python")


def test_review_code_happy_path_with_language_override(client):
    """Test /review passes explicit language to reviewer."""
    mock_result = Mock()
    mock_result.score = 90
    mock_result.issues = []
    mock_result.suggestions = []
    mock_result.complexity_score = 1.0

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_code.return_value = mock_result

        response = client.post(
            "/review",
            json={"content": "console.log('hi')", "language": "javascript"},
        )
        assert response.status_code == 200
        data = response.get_json()
        assert data["score"] == 90
        assert data["complexity_score"] == pytest.approx(1.0)
        assert data["issues"] == []
        assert data["suggestions"] == []
        assert data["cached"] is False

        mock_reviewer.review_code.assert_called_once_with(
            "console.log('hi')", "javascript"
        )


def test_review_function_missing_function_code_returns_400(client):
    """Test /review/function returns 400 when 'function_code' is missing."""
    response = client.post("/review/function", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data["error"] == "Missing 'function_code' field"


def test_review_function_no_json_returns_400(client):
    """Test /review/function returns 400 when no JSON body is provided."""
    response = client.post("/review/function")
    assert response.status_code == 400
    data = response.get_json()
    assert data["error"] == "Missing 'function_code' field"


def test_review_function_happy_path_calls_reviewer(client):
    """Test /review/function happy path delegates to reviewer.review_function."""
    expected_result = {"score": 75, "details": "ok"}

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_function.return_value = expected_result

        response = client.post(
            "/review/function",
            json={"function_code": "def foo(): pass"},
        )
        assert response.status_code == 200
        data = response.get_json()
        assert data == expected_result

        mock_reviewer.review_function.assert_called_once_with("def foo(): pass")


def test_clear_cache_endpoint_empties_cache(client):
    """Test /cache/clear endpoint clears the global cache."""
    cache["k1"] = {"data": {"a": 1}, "expires_at": 999999}
    cache["k2"] = {"data": {"b": 2}, "expires_at": 999999}
    assert len(cache) == 2

    response = client.post("/cache/clear")
    assert response.status_code == 200
    data = response.get_json()
    assert data["message"] == "Cache cleared successfully"
    assert len(cache) == 0


def test_cache_stats_endpoint_counts_active_and_expired_entries(client, monkeypatch):
    """Test /cache/stats returns correct counts for active and expired entries."""
    base_time = 1000.0
    monkeypatch.setattr("src.app.time.time", lambda: base_time)

    cache["active1"] = {"data": {"x": 1}, "expires_at": base_time + 10}
    cache["active2"] = {"data": {"y": 2}, "expires_at": base_time + 5}
    cache["expired1"] = {"data": {"z": 3}, "expires_at": base_time - 1}

    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 3
    assert data["active_entries"] == 2
    assert data["expired_entries"] == 1
    assert data["cache_ttl"] == CACHE_TTL


def test_cache_stats_endpoint_with_empty_cache(client):
    """Test /cache/stats returns zeros when cache is empty."""
    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 0
    assert data["active_entries"] == 0
    assert data["expired_entries"] == 0
    assert data["cache_ttl"] == CACHE_TTL


def test_cached_decorator_uses_prefix_in_cache_key(client):
    """Test cached decorator uses provided prefix to separate cache namespaces."""
    calls_a = {"count": 0}
    calls_b = {"count": 0}

    @cached("prefix_a")
    def view_a():
        calls_a["count"] += 1
        return json.jsonify({"view": "a"})

    @cached("prefix_b")
    def view_b():
        calls_b["count"] += 1
        return json.jsonify({"view": "b"})

    with app.test_request_context(json={"content": "same"}):
        view_a()
        view_b()

    with app.test_request_context(json={"content": "same"}):
        view_a()
        view_b()

    assert calls_a["count"] == 1
    assert calls_b["count"] == 1
    assert len(cache) == 2