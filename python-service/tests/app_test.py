import time
import json
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
    """Provide a Flask test client with app context."""
    with app.test_client() as client:
        with app.app_context():
            yield client


@pytest.fixture(autouse=True)
def clear_cache_before_test():
    """Clear the global cache before each test."""
    cache.clear()
    yield
    cache.clear()


@pytest.mark.parametrize(
    "prefix,data1,data2,should_match",
    [
        ("p1", "content", "content", True),
        ("p1", "content", "other", False),
        ("p1", "content", "content ", False),
        ("p2", "content", "content", True),
        ("p1", "", "", True),
        ("p1", "123", "321", False),
    ],
)
def test_generate_cache_key_deterministic_and_sensitive(prefix, data1, data2, should_match):
    """Test generate_cache_key is deterministic and sensitive to prefix and data."""
    key1 = generate_cache_key(prefix, data1)
    key2 = generate_cache_key(prefix, data2)
    if should_match:
        assert key1 == key2
    else:
        assert key1 != key2


def test_cached_decorator_caches_successful_response(client):
    """Test that the cached decorator caches a successful JSON response."""
    mock_view = Mock()

    @cached("test")
    def test_view():
        return jsonify({"value": mock_view()})

    from flask import jsonify, request

    with app.test_request_context(
        "/dummy", method="POST", data=json.dumps({"content": "abc"}), content_type="application/json"
    ):
        mock_view.return_value = 1
        response1 = test_view()
        data1 = response1.get_json()
        assert data1["value"] == 1
        assert data1["cached"] is False
        assert mock_view.call_count == 1

        mock_view.return_value = 2
        response2 = test_view()
        data2 = response2.get_json()
        assert data2["value"] == 1
        assert data2["cached"] is True
        assert mock_view.call_count == 1


def test_cached_decorator_uses_content_field_only(client):
    """Test that cache key is based only on 'content' field in JSON body."""
    from flask import jsonify

    call_counter = {"count": 0}

    @cached("test")
    def test_view():
        call_counter["count"] += 1
        return jsonify({"value": call_counter["count"]})

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "same", "other": 1}),
        content_type="application/json",
    ):
        resp1 = test_view()
        data1 = resp1.get_json()
        assert data1["value"] == 1
        assert data1["cached"] is False

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "same", "other": 2}),
        content_type="application/json",
    ):
        resp2 = test_view()
        data2 = resp2.get_json()
        assert data2["value"] == 1
        assert data2["cached"] is True

    assert call_counter["count"] == 1


def test_cached_decorator_no_body_uses_empty_content(client):
    """Test that cached decorator handles missing JSON body gracefully."""
    from flask import jsonify

    call_counter = {"count": 0}

    @cached("test")
    def test_view():
        call_counter["count"] += 1
        return jsonify({"value": call_counter["count"]})

    with app.test_request_context("/dummy", method="POST"):
        resp1 = test_view()
        data1 = resp1.get_json()
        assert data1["value"] == 1
        assert data1["cached"] is False

    with app.test_request_context("/dummy", method="POST"):
        resp2 = test_view()
        data2 = resp2.get_json()
        assert data2["value"] == 1
        assert data2["cached"] is True

    assert call_counter["count"] == 1


def test_cached_decorator_does_not_cache_tuple_response(client):
    """Test that cached decorator does not cache when view returns a tuple."""
    from flask import jsonify

    call_counter = {"count": 0}

    @cached("test")
    def test_view():
        call_counter["count"] += 1
        return jsonify({"value": call_counter["count"]}), 400

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "abc"}),
        content_type="application/json",
    ):
        resp1, status1 = test_view()
        assert status1 == 400
        assert resp1.get_json()["value"] == 1

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "abc"}),
        content_type="application/json",
    ):
        resp2, status2 = test_view()
        assert status2 == 400
        assert resp2.get_json()["value"] == 2

    assert call_counter["count"] == 2


def test_cached_decorator_expires_entries(client, monkeypatch):
    """Test that cached decorator expires entries based on CACHE_TTL."""
    from flask import jsonify

    @cached("test")
    def test_view():
        return jsonify({"value": time.time()})

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "abc"}),
        content_type="application/json",
    ):
        with patch("src.app.time.time") as mock_time:
            mock_time.return_value = 1000.0
            resp1 = test_view()
            data1 = resp1.get_json()
            assert data1["cached"] is False

    with app.test_request_context(
        "/dummy",
        method="POST",
        data=json.dumps({"content": "abc"}),
        content_type="application/json",
    ):
        with patch("src.app.time.time") as mock_time:
            mock_time.return_value = 1000.0 + CACHE_TTL + 1
            resp2 = test_view()
            data2 = resp2.get_json()
            assert data2["cached"] is False


def test_health_check_returns_expected_payload(client):
    """Test /health endpoint returns expected JSON and status."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data == {"status": "healthy", "service": "python-reviewer"}


def test_review_code_missing_body_returns_400(client):
    """Test /review returns 400 when no JSON body is provided."""
    response = client.post("/review")
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'content' field"}


def test_review_code_missing_content_field_returns_400(client):
    """Test /review returns 400 when 'content' field is missing."""
    response = client.post(
        "/review",
        data=json.dumps({"language": "python"}),
        content_type="application/json",
    )
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'content' field"}


def _build_mock_review_result():
    """Helper to build a mock review result object."""
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
    result.suggestions = ["Suggestion 1", "Suggestion 2"]
    result.complexity_score = 3.5
    return result


def test_review_code_happy_path_default_language(client):
    """Test /review with valid payload and default language."""
    mock_result = _build_mock_review_result()

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_code.return_value = mock_result

        response = client.post(
            "/review",
            data=json.dumps({"content": "print('hello')"}),
            content_type="application/json",
        )

    assert response.status_code == 200
    data = response.get_json()
    assert data["score"] == 85
    assert data["suggestions"] == ["Suggestion 1", "Suggestion 2"]
    assert data["complexity_score"] == pytest.approx(3.5)
    assert len(data["issues"]) == 2
    assert data["issues"][0]["severity"] == "high"
    assert data["issues"][0]["line"] == 10
    assert data["issues"][0]["message"] == "Issue 1"
    assert data["issues"][0]["suggestion"] == "Fix 1"
    assert "cached" in data
    assert data["cached"] is False


@pytest.mark.parametrize("language", ["python", "javascript", "go"])
def test_review_code_happy_path_with_language_param(client, language):
    """Test /review passes language parameter to reviewer.review_code."""
    mock_result = _build_mock_review_result()

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_code.return_value = mock_result

        response = client.post(
            "/review",
            data=json.dumps({"content": "code", "language": language}),
            content_type="application/json",
        )

        assert response.status_code == 200
        mock_reviewer.review_code.assert_called_once_with("code", language)
        data = response.get_json()
        assert data["score"] == 85
        assert "cached" in data


def test_review_code_caching_behavior(client):
    """Test that /review endpoint uses caching between identical requests."""
    mock_result = _build_mock_review_result()

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_code.return_value = mock_result

        response1 = client.post(
            "/review",
            data=json.dumps({"content": "same code", "language": "python"}),
            content_type="application/json",
        )
        data1 = response1.get_json()
        assert response1.status_code == 200
        assert data1["cached"] is False
        assert mock_reviewer.review_code.call_count == 1

        response2 = client.post(
            "/review",
            data=json.dumps({"content": "same code", "language": "python"}),
            content_type="application/json",
        )
        data2 = response2.get_json()
        assert response2.status_code == 200
        assert data2["cached"] is True
        assert mock_reviewer.review_code.call_count == 1


def test_review_function_missing_body_returns_400(client):
    """Test /review/function returns 400 when no JSON body is provided."""
    response = client.post("/review/function")
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'function_code' field"}


def test_review_function_missing_field_returns_400(client):
    """Test /review/function returns 400 when 'function_code' is missing."""
    response = client.post(
        "/review/function",
        data=json.dumps({"other": "value"}),
        content_type="application/json",
    )
    assert response.status_code == 400
    data = response.get_json()
    assert data == {"error": "Missing 'function_code' field"}


def test_review_function_happy_path(client):
    """Test /review/function with valid payload."""
    mock_return = {"result": "ok", "details": {"score": 90}}

    with patch("src.app.reviewer") as mock_reviewer:
        mock_reviewer.review_function.return_value = mock_return

        response = client.post(
            "/review/function",
            data=json.dumps({"function_code": "def foo(): pass"}),
            content_type="application/json",
        )

    assert response.status_code == 200
    data = response.get_json()
    assert data == mock_return
    mock_reviewer.review_function.assert_called_once_with("def foo(): pass")


def test_clear_cache_endpoint_clears_cache(client):
    """Test /cache/clear endpoint clears the global cache."""
    cache["key1"] = {"data": {"a": 1}, "expires_at": time.time() + 100}
    cache["key2"] = {"data": {"b": 2}, "expires_at": time.time() - 100}
    assert len(cache) == 2

    response = client.post("/cache/clear")
    assert response.status_code == 200
    data = response.get_json()
    assert data == {"message": "Cache cleared successfully"}
    assert len(cache) == 0


def test_cache_stats_with_mixed_entries(client):
    """Test /cache/stats reports correct counts for active and expired entries."""
    now = time.time()
    cache["active1"] = {"data": {"x": 1}, "expires_at": now + 10}
    cache["active2"] = {"data": {"y": 2}, "expires_at": now + 20}
    cache["expired1"] = {"data": {"z": 3}, "expires_at": now - 5}

    with patch("src.app.time.time", return_value=now):
        response = client.get("/cache/stats")

    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 3
    assert data["active_entries"] == 2
    assert data["expired_entries"] == 1
    assert data["cache_ttl"] == CACHE_TTL


def test_cache_stats_empty_cache(client):
    """Test /cache/stats when cache is empty."""
    response = client.get("/cache/stats")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total_entries"] == 0
    assert data["active_entries"] == 0
    assert data["expired_entries"] == 0
    assert data["cache_ttl"] == CACHE_TTL


def test_cached_decorator_wrapper_name_and_docstring_preserved():
    """Test that cached decorator preserves function metadata via wraps."""
    from flask import jsonify

    @cached("test")
    def original_function():
        """Original docstring."""
        return jsonify({"ok": True})

    assert original_function.__name__ == "original_function"
    assert original_function.__doc__ == "Original docstring."