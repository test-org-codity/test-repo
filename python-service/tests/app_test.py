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
)


@pytest.fixture
def client():
    """Create a Flask test client and ensure cache is cleared before each test."""
    with app.test_client() as client:
        cache.clear()
        yield client
        cache.clear()


@pytest.fixture
def mock_request_json(monkeypatch):
    """Fixture to help mock flask.request.get_json."""

    def _set_json(data):
        from flask import request

        # Patch only for this call context
        monkeypatch.setattr(request, "get_json", lambda: data)

    return _set_json


@pytest.fixture
def mock_reviewer():
    """Fixture to mock the CodeReviewer instance in app."""
    with patch("src.app.reviewer") as mock:
        yield mock


@pytest.mark.parametrize(
    "prefix,data1,data2,expect_equal",
    [
        ("p", "content", "content", True),
        ("p", "content", "other", False),
        ("p1", "content", "content", False),
        ("", "", "", True),
    ],
)
def test_generate_cache_key_deterministic_and_prefix_sensitive(
    prefix, data1, data2, expect_equal
):
    """Test generate_cache_key creates deterministic and prefix-sensitive keys."""
    key1 = generate_cache_key(prefix, data1)
    key2 = generate_cache_key(prefix, data2)
    assert isinstance(key1, str)
    assert isinstance(key2, str)
    if expect_equal:
        assert key1 == key2
    else:
        assert key1 != key2

    # Also ensure it's a valid SHA256 hex digest (64 hex chars)
    assert len(key1) == 64
    int(key1, 16)


def test_cached_decorator_cache_hit_and_miss(client, monkeypatch):
    """Test cached decorator caches results and returns cached data with flag."""
    # Define a simple view function to wrap
    calls = {"count": 0}

    @cached("test")
    def sample_view():
        calls["count"] += 1
        from flask import jsonify

        return jsonify({"value": "result"})

    # First call should be a miss and set cached=False
    with app.test_request_context(
        "/dummy", method="POST", json={"content": "abc"}
    ):
        response = sample_view()
        data = response.get_json()
        assert data["value"] == "result"
        assert data["cached"] is False
        assert calls["count"] == 1

    # Second call with same content should be a hit and cached=True
    with app.test_request_context(
        "/dummy", method="POST", json={"content": "abc"}
    ):
        response = sample_view()
        data = response.get_json()
        assert data["value"] == "result"
        assert data["cached"] is True
        # Underlying function should not be called again
        assert calls["count"] == 1


def test_cached_decorator_cache_expiration(client, monkeypatch):
    """Test cached decorator expires entries based on CACHE_TTL."""
    base_time = time.time()
    times = [base_time, base_time + CACHE_TTL + 1]

    def fake_time():
        return times.pop(0)

    calls = {"count": 0}

    @cached("expire_test")
    def sample_view():
        calls["count"] += 1
        from flask import jsonify

        return jsonify({"value": "result"})

    with patch("src.app.time.time", side_effect=fake_time):
        # First call stores in cache
        with app.test_request_context(
            "/dummy", method="POST", json={"content": "abc"}
        ):
            response = sample_view()
            data = response.get_json()
            assert data["cached"] is False
            assert calls["count"] == 1

        # Second call after TTL should miss and call function again
        with app.test_request_context(
            "/dummy", method="POST", json={"content": "abc"}
        ):
            response = sample_view()
            data = response.get_json()
            # Because entry expired, decorator treats this as new call
            assert data["cached"] is False
            assert calls["count"] == 2


def test_cached_decorator_passthrough_for_tuple_response(client):
    """Test cached decorator passes through tuple responses without caching."""
    calls = {"count": 0}

    @cached("tuple_test")
    def sample_view():
        from flask import jsonify

        calls["count"] += 1
        return jsonify({"value": "result"}), 201

    with app.test_request_context(
        "/dummy", method="POST", json={"content": "abc"}
    ):
        response, status = sample_view()
        assert status == 201
        data = response.get_json()
        assert "cached" not in data
        assert calls["count"] == 1

    # Second call should not be cached since tuple responses are not cached
    with app.test_request_context(
        "/dummy", method="POST", json={"content": "abc"}
    ):
        response, status = sample_view()
        assert status == 201
        data = response.get_json()
        assert "cached" not in data
        assert calls["count"] == 2


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


def test_review_code_with_valid_input_default_language(client, mock_reviewer):
    """Test /review with valid input uses default language and returns expected data with caching."""
    mock_issue = Mock(
        severity="high",
        line=10,
        message="Issue message",
        suggestion="Fix it",
    )
    mock_result = Mock(
        score=85,
        issues=[mock_issue],
        suggestions=["Suggestion 1"],
        complexity_score=5.5,
    )
    mock_reviewer.review_code.return_value = mock_result

    payload = {"content": "some code"}
    response = client.post("/review", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data["score"] == 85
    assert data["suggestions"] == ["Suggestion 1"]
    assert data["complexity_score"] == pytest.approx(5.5)
    assert data["cached"] is False
    assert isinstance(data["issues"], list)
    assert data["issues"][0] == {
        "severity": "high",
        "line": 10,
        "message": "Issue message",
        "suggestion": "Fix it",
    }

    mock_reviewer.review_code.assert_called_once_with("some code", "python")


def test_review_code_with_valid_input_custom_language(client, mock_reviewer):
    """Test /review with a specified language passes it to reviewer."""
    mock_result = Mock(
        score=70, issues=[], suggestions=[], complexity_score=1.0
    )
    mock_reviewer.review_code.return_value = mock_result

    payload = {"content": "some code", "language": "javascript"}
    response = client.post("/review", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data["score"] == 70
    assert data["cached"] is False
    mock_reviewer.review_code.assert_called_once_with("some code", "javascript")


def test_review_code_uses_cache_on_second_call(client, mock_reviewer):
    """Test /review uses cached response on subsequent identical requests."""
    mock_result = Mock(
        score=90, issues=[], suggestions=[], complexity_score=2.0
    )
    mock_reviewer.review_code.return_value = mock_result

    payload = {"content": "same code"}

    first_response = client.post("/review", json=payload)
    first_data = first_response.get_json()
    assert first_response.status_code == 200
    assert first_data["cached"] is False
    assert first_data["score"] == 90

    # Second call should be cached and not call reviewer again
    second_response = client.post("/review", json=payload)
    second_data = second_response.get_json()
    assert second_response.status_code == 200
    assert second_data["cached"] is True
    assert second_data["score"] == 90
    mock_reviewer.review_code.assert_called_once()


def test_review_function_missing_function_code_field(client):
    """Test /review/function returns 400 when 'function_code' is missing."""
    response = client.post("/review/function", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'function_code' field"}


def test_review_function_with_valid_input(client, mock_reviewer):
    """Test /review/function with valid input returns reviewer result as-is."""
    expected_result = {
        "score": 95,
        "details": "All good",
    }
    mock_reviewer.review_function.return_value = expected_result

    payload = {"function_code": "def foo(): pass"}
    response = client.post("/review/function", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data == expected_result
    mock_reviewer.review_function.assert_called_once_with("def foo(): pass")


def test_clear_cache_endpoint_clears_cache(client):
    """Test /cache/clear endpoint clears the cache."""
    # Pre-fill cache
    cache["test"] = {"data": {"a": 1}, "expires_at": time.time() + 100}
    assert len(cache) == 1

    response = client.post("/cache/clear")
    assert response.status_code == 200
    data = response.get_json()
    assert data == {"message": "Cache cleared successfully"}
    assert len(cache) == 0


def test_cache_stats_with_active_and_expired_entries(client, monkeypatch):
    """Test /cache/stats reports correct counts for active and expired entries."""
    base_time = time.time()
    cache.clear()
    cache["active1"] = {"data": {}, "expires_at": base_time + 10}
    cache["active2"] = {"data": {}, "expires_at": base_time + 5}
    cache["expired1"] = {"data": {}, "expires_at": base_time - 1}

    with patch("src.app.time.time", return_value=base_time):
        response = client.get("/cache/stats")

    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 3
    assert data["active_entries"] == 2
    assert data["expired_entries"] == 1
    assert data["cache_ttl"] == CACHE_TTL


def test_cache_stats_with_empty_cache(client):
    """Test /cache/stats when cache is empty."""
    cache.clear()
    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 0
    assert data["active_entries"] == 0
    assert data["expired_entries"] == 0
    assert data["cache_ttl"] == CACHE_TTL