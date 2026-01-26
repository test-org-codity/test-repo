import json
import os
import time
from collections import deque
from unittest.mock import Mock, patch

import pytest

from src.circuit_breaker import (
    CircuitState,
    CircuitBreakerConfig,
    CircuitBreakerMetrics,
    CircuitBreakerOpenError,
    CircuitBreaker,
    DistributedCircuitBreakerCoordinator,
    circuit_breaker,
)


@pytest.fixture(autouse=True)
def reset_registry():
    """Ensure CircuitBreaker registry is cleared between tests."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def small_config():
    """Provide a CircuitBreakerConfig with small thresholds for testing."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.05,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(small_config):
    """Create a CircuitBreaker instance for tests."""
    return CircuitBreaker(name="test-service", config=small_config)


def success_op():
    """A successful operation."""
    return "ok"


def failing_op():
    """An operation that fails."""
    raise ValueError("failure")


def test_circuit_state_values():
    """Test CircuitState enum values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test CircuitBreakerConfig default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_metrics_record_response_time_average():
    """Test CircuitBreakerMetrics records and averages response times."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.2)
    assert metrics.average_response_time == pytest.approx(0.15, rel=1e-3)
    assert isinstance(metrics._response_times, deque)
    assert len(metrics._response_times) == 2


def test_open_error_contains_name_and_remaining_time():
    """Test CircuitBreakerOpenError contains correct name and remaining time."""
    err = CircuitBreakerOpenError("svc", 1.234)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.234)
    assert "Circuit breaker 'svc' is open" in str(err)


def test_get_or_create_returns_singleton_per_name(small_config):
    """Test CircuitBreaker.get_or_create returns same instance per name and respects first config."""
    cb1 = CircuitBreaker.get_or_create("svc-a", small_config)
    cb2 = CircuitBreaker.get_or_create("svc-a", CircuitBreakerConfig(failure_threshold=99))
    cb3 = CircuitBreaker.get_or_create("svc-b", small_config)
    assert cb1 is cb2
    assert cb1 is not cb3
    assert cb1.config.failure_threshold == 2  # from small_config
    assert cb3.config.failure_threshold == 2


def test_transition_to_updates_state_and_counters(breaker):
    """Test _transition_to sets state and counters appropriately."""
    # Initial
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.state_transitions == 0

    # OPEN
    breaker._transition_to(CircuitState.OPEN)
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at is not None
    assert breaker.metrics.state_transitions == 1

    # HALF_OPEN
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 2

    # CLOSED
    breaker._failure_count = 5
    breaker._success_count = 5
    breaker._sliding_window.append(True)
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == 3


def test_should_attempt_reset_logic(breaker):
    """Test _should_attempt_reset returns True after timeout and False otherwise."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time()
    assert breaker._should_attempt_reset() is False

    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    assert breaker._should_attempt_reset() is True


def test_state_auto_transitions_to_half_open_after_timeout(breaker):
    """Test that breaker.state transitions from OPEN to HALF_OPEN after timeout when accessed."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    # Accessing state should attempt reset
    assert breaker.state == CircuitState.HALF_OPEN


def test_execute_success_increments_metrics(breaker):
    """Test execute on success updates metrics and returns result."""
    result = breaker.execute(success_op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    # average_response_time is a float; just check it's recorded
    assert breaker.metrics.average_response_time >= 0.0


def test_execute_failure_increments_metrics_and_raises(breaker):
    """Test execute on failure increments failed_calls and re-raises exception."""
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1


def test_allow_request_half_open_limits(breaker):
    """Test _allow_request permits limited calls in HALF_OPEN and then rejects."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._allow_request() is True
    assert breaker._allow_request() is True
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == breaker.config.half_open_max_calls


def test_execute_rejected_when_open_without_fallback_raises(breaker):
    """Test execute raises CircuitBreakerOpenError when OPEN without fallback."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time()
    with pytest.raises(CircuitBreakerOpenError) as ei:
        breaker.execute(success_op)
    err = ei.value
    assert err.name == "test-service"
    assert err.remaining_time == pytest.approx(breaker.config.timeout_seconds, rel=0.2)
    assert breaker.metrics.rejected_calls == 1


def test_execute_rejected_with_fallback_returns_value(breaker):
    """Test execute returns fallback when request is rejected."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time()

    op = Mock(side_effect=AssertionError("should not be called"))
    fallback = Mock(return_value="fallback")
    result = breaker.execute(op, fallback=fallback)
    assert result == "fallback"
    op.assert_not_called()
    fallback.assert_called_once()
    assert breaker.metrics.rejected_calls == 1


def test_record_failure_opens_on_failure_threshold():
    """Test that breaker opens when failure_threshold is reached."""
    cfg = CircuitBreakerConfig(failure_threshold=2, success_threshold=1, timeout_seconds=0.01, sliding_window_size=4)
    br = CircuitBreaker("svc", cfg)
    assert br.state == CircuitState.CLOSED

    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.state == CircuitState.CLOSED

    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.state == CircuitState.OPEN


def test_record_failure_opens_on_failure_rate_when_window_full():
    """Test breaker opens when failure rate threshold is met and window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # high to force rate-based open
        success_threshold=1,
        timeout_seconds=0.01,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("svc-rate", cfg)

    # 2 successes
    br.execute(success_op)
    br.execute(success_op)
    # 1st failure
    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.state == CircuitState.CLOSED  # not open yet

    # 2nd failure triggers window full: [T, T, F, F] => 0.5 failure rate
    with pytest.raises(ValueError):
        br.execute(failing_op)

    assert br.state == CircuitState.OPEN


def test_calculate_failure_rate_behavior(breaker):
    """Test _calculate_failure_rate returns 0.0 until window full and then actual rate."""
    # Initially empty
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    # Fill partially (less than size)
    breaker._sliding_window.extend([True, False])
    assert len(breaker._sliding_window) < breaker.config.sliding_window_size
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    # Fill to exact size with 3 failures out of 4
    breaker._sliding_window.clear()
    breaker._sliding_window.extend([False, True, False, False])
    assert len(breaker._sliding_window) == breaker.config.sliding_window_size
    assert breaker._calculate_failure_rate() == pytest.approx(0.75, rel=1e-6)


def test_get_health_info_contains_expected_fields(breaker):
    """Test get_health_info structure and key values."""
    # Produce one success and one failure
    breaker.execute(success_op)
    with pytest.raises(ValueError):
        breaker.execute(failing_op)

    info = breaker.get_health_info()
    assert info["name"] == "test-service"
    assert info["state"] in {s.value for s in CircuitState}
    assert "failure_count" in info
    assert "success_count" in info
    assert "failure_rate" in info
    assert "metrics" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 1
    assert isinstance(info["metrics"]["average_response_time_ms"], float)
    assert info["metrics"]["average_response_time_ms"] >= 0.0


def test_half_open_successes_close_breaker(breaker):
    """Test that sufficient successes in HALF_OPEN transition to CLOSED."""
    # Open it first
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    assert breaker.state == CircuitState.OPEN

    # Move to HALF_OPEN by simulating timeout pass
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    assert breaker.state == CircuitState.HALF_OPEN

    # Successes equal to success_threshold should close
    breaker.execute(success_op)
    assert breaker.state == CircuitState.HALF_OPEN
    breaker.execute(success_op)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0


def test_half_open_failure_reopens_immediately(breaker):
    """Test that a failure in HALF_OPEN transitions to OPEN immediately."""
    # Open first
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    assert breaker.state == CircuitState.OPEN

    # Move to HALF_OPEN
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    assert breaker.state == CircuitState.HALF_OPEN

    # One failure should open immediately
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    assert breaker.state == CircuitState.OPEN


def test_decorator_circuit_breaker_wraps_and_attaches_breaker(small_config):
    """Test circuit_breaker decorator wraps function and exposes breaker attribute."""
    @circuit_breaker("decorated-svc", config=small_config)
    def fn(x):
        return x * 2

    assert hasattr(fn, "circuit_breaker")
    assert isinstance(fn.circuit_breaker, CircuitBreaker)
    assert fn(3) == 6
    assert fn.circuit_breaker.metrics.total_calls == 1


def test_coordinator_register_breaker_sends_registration(monkeypatch, breaker):
    """Test coordinator sends registration request on register_breaker."""
    monkeypatch.setenv("NODE_ID", "node-123")

    captured = {}

    def fake_urlopen(req, timeout=5):
        captured["url"] = req.full_url
        captured["data"] = req.data
        captured["method"] = req.get_method()
        class Resp:
            def read(self): return b""
        return Resp()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as m:
        coord = DistributedCircuitBreakerCoordinator("http://coordinator")
        coord.register_breaker(breaker)

    assert m.called
    assert captured["url"].endswith("/circuit-breakers/register")
    assert captured["method"] == "POST"
    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["service"] == "test-service"
    assert payload["node_id"] == "node-123"
    assert payload["failure_threshold"] == breaker.config.failure_threshold
    assert payload["success_threshold"] == breaker.config.success_threshold


def test_coordinator_synchronize_states_posts_state(monkeypatch, breaker):
    """Test _synchronize_states posts current breaker state and health info."""
    monkeypatch.setenv("NODE_ID", "node-xyz")

    posted = []

    def fake_urlopen(req, timeout=5):
        posted.append((req.full_url, req.data, req.get_method()))
        class Resp:
            def read(self): return b""
        return Resp()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        coord.register_breaker(breaker)
        # Generate some activity
        breaker.execute(success_op)
        try:
            breaker.execute(failing_op)
        except ValueError:
            pass
        coord._synchronize_states()

    assert any(url.endswith("/circuit-breakers/state") for (url, _, _) in posted)
    url, data, method = posted[-1]
    assert method == "POST"
    payload = json.loads(data.decode("utf-8"))
    assert payload["service"] == "test-service"
    assert payload["node_id"] == "node-xyz"
    assert payload["state"] in {s.value for s in CircuitState}
    assert "health_info" in payload
    assert payload["health_info"]["metrics"]["total_calls"] == 2


def test_coordinator_start_and_stop_sync_calls_synchronize_states_once(monkeypatch, breaker):
    """Test start_sync launches thread and stop_sync stops it after one loop."""
    calls = {"count": 0}

    def fake_sync(self):
        calls["count"] += 1
        # Stop after first call
        self._running = False

    coord = DistributedCircuitBreakerCoordinator("http://coord", sync_interval=0.01)
    coord.register_breaker(breaker)

    monkeypatch.setattr(DistributedCircuitBreakerCoordinator, "_synchronize_states", fake_sync, raising=False)
    coord.start_sync()
    coord.stop_sync()

    assert calls["count"] >= 1


def test_coordinator_get_cluster_state_success_and_error():
    """Test get_cluster_state returns parsed JSON on success and error dict on failure."""
    good_response = {"status": "ok", "nodes": 3}

    class Resp:
        def read(self):
            return json.dumps(good_response).encode("utf-8")

    def fake_urlopen_success(req, timeout=5):
        return Resp()

    def fake_urlopen_error(req, timeout=5):
        from urllib.error import URLError
        raise URLError("down")

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen_success):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        out = coord.get_cluster_state("svc")
        assert out == good_response

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen_error):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        out = coord.get_cluster_state("svc")
        assert "error" in out and "Failed to fetch cluster state" in out["error"]