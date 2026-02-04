import json
import time
import threading
import pytest
from unittest.mock import Mock, patch, call

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
    """Reset the CircuitBreaker registry before each test to avoid cross-test state."""
    original = CircuitBreaker._registry.copy()
    CircuitBreaker._registry.clear()
    try:
        yield
    finally:
        CircuitBreaker._registry.clear()
        CircuitBreaker._registry.update(original)


@pytest.fixture
def small_config():
    """Provide a small-threshold config for faster tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=1.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(small_config):
    """Create a CircuitBreaker instance with small thresholds."""
    return CircuitBreaker("test-service", config=small_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator with a dummy URL."""
    return DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)


def test_circuit_state_values():
    """Test that CircuitState enum has expected values."""
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
    """Test CircuitBreakerMetrics.record_response_time computes running average."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_get_or_create_singleton_and_config():
    """Test get_or_create returns same instance and preserves initial config."""
    cfg = CircuitBreakerConfig(failure_threshold=9)
    br1 = CircuitBreaker.get_or_create("svc", config=cfg)
    br2 = CircuitBreaker.get_or_create("svc")
    assert br1 is br2
    assert br1.config.failure_threshold == 9


def test_circuit_breaker_state_open_to_half_open_after_timeout(breaker, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN after timeout elapses."""
    base = 1000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(base)

    # After timeout_seconds elapsed, accessing state should transition to HALF_OPEN
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds + 0.1)
    transitions_before = breaker.metrics.state_transitions
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions == transitions_before + 1


def test_circuit_breaker_should_attempt_reset(breaker, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout has passed."""
    assert breaker._should_attempt_reset() is False
    base = 2000.0
    breaker._opened_at = base
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds - 0.5)
    assert breaker._should_attempt_reset() is False
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds + 0.01)
    assert breaker._should_attempt_reset() is True


def test_circuit_breaker_transition_to_resets_and_sets_fields(breaker, monkeypatch):
    """Test _transition_to behavior for OPEN, HALF_OPEN, and CLOSED states."""
    base = 3000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    # Prepare some state
    breaker._failure_count = 5
    breaker._success_count = 4
    breaker._half_open_calls = 2
    breaker._sliding_window.extend([True, False, True])

    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0

    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(base)

    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0


def test_circuit_breaker_execute_success_and_metrics(breaker):
    """Test execute success path increments metrics and records response time."""
    result = breaker.execute(lambda: "ok")
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time >= 0.0


def test_circuit_breaker_execute_failure_increments_and_raises(breaker):
    """Test execute failure path increments failure metrics and re-raises exception."""
    def op():
        raise ValueError("boom")
    with pytest.raises(ValueError):
        breaker.execute(op)
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.successful_calls == 0


def test_circuit_breaker_execute_rejects_when_open_with_fallback(breaker, monkeypatch):
    """Test execute when OPEN uses fallback and increments rejected_calls without calling operation."""
    base = 4000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    breaker._transition_to(CircuitState.OPEN)

    op = Mock(side_effect=AssertionError("Should not be called"))
    fb = Mock(return_value="fallback")

    res = breaker.execute(op, fallback=fb)
    assert res == "fallback"
    op.assert_not_called()
    fb.assert_called_once()
    assert breaker.metrics.rejected_calls == 1
    assert breaker.metrics.total_calls == 0  # Not counted when rejected


def test_circuit_breaker_execute_rejects_when_open_without_fallback_raises_open_error(breaker, monkeypatch):
    """Test execute when OPEN raises CircuitBreakerOpenError with correct remaining time."""
    base = 5000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    breaker._transition_to(CircuitState.OPEN)

    # Advance time slightly but still within timeout
    now = base + 0.2
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: now)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        breaker.execute(lambda: "nope")
    err = exc.value
    assert err.name == breaker.name
    expected_remaining = breaker.config.timeout_seconds - (now - base)
    assert err.remaining_time == pytest.approx(expected_remaining, rel=1e-3, abs=1e-3)
    assert breaker.metrics.rejected_calls == 1
    assert breaker.metrics.total_calls == 0


def test_circuit_breaker_allow_request_half_open_limit_calls(breaker):
    """Test _allow_request in HALF_OPEN allows up to max calls and then rejects."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._allow_request() is True
    assert breaker._allow_request() is True
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == breaker.config.half_open_max_calls


def test_circuit_breaker_record_success_in_closed_decrements_failure_count_and_updates_metrics(breaker):
    """Test _record_success in CLOSED decrements failure_count and updates sliding window and metrics."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._failure_count = 2
    breaker._record_success(0.1)
    assert breaker._failure_count == 1
    breaker._record_success(0.3)
    assert breaker._failure_count == 0
    breaker._record_success(0.5)
    assert breaker._failure_count == 0  # Not below zero
    assert list(breaker._sliding_window)[-1] is True
    assert breaker.metrics.successful_calls == 3
    assert breaker.metrics.average_response_time == pytest.approx((0.1 + 0.3 + 0.5) / 3.0)


def test_circuit_breaker_record_success_in_half_open_closes_after_threshold(breaker):
    """Test _record_success in HALF_OPEN closes breaker after reaching success_threshold."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_success(0.05)
    assert breaker.state == CircuitState.HALF_OPEN
    breaker._record_success(0.07)
    assert breaker.state == CircuitState.CLOSED


def test_circuit_breaker_record_failure_in_half_open_opens_immediately(breaker):
    """Test _record_failure transitions to OPEN immediately when in HALF_OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_failure(0.02)
    assert breaker.state == CircuitState.OPEN


def test_circuit_breaker_record_failure_in_closed_opens_on_threshold(breaker):
    """Test _record_failure in CLOSED opens breaker after reaching failure_threshold."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._record_failure(0.01)
    assert breaker.state == CircuitState.CLOSED
    breaker._record_failure(0.01)
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at is not None


def test_circuit_breaker_record_failure_opens_on_failure_rate_threshold_only():
    """Test breaker opens due to failure rate threshold when sliding window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # effectively disable count threshold
        success_threshold=2,
        timeout_seconds=5.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("rate-test", config=cfg)
    br._transition_to(CircuitState.CLOSED)

    # Fill sliding window with failures to exceed threshold on the 4th event
    br._record_failure(0.01)
    assert br.state == CircuitState.CLOSED  # not enough window yet
    br._record_failure(0.01)
    assert br.state == CircuitState.CLOSED
    br._record_failure(0.01)
    assert br.state == CircuitState.CLOSED
    br._record_failure(0.01)
    assert br.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate(breaker):
    """Test _calculate_failure_rate returns 0.0 when window not full and correct ratio when full."""
    # Less than window size -> 0.0
    breaker._sliding_window.extend([True, False])
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    # Fill to window size
    breaker._sliding_window.clear()
    breaker._sliding_window.extend([True, False, True, False])  # 2 failures out of 4 -> 0.5
    assert breaker._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_contains_expected_fields(breaker):
    """Test get_health_info returns expected structure and computes averages in ms."""
    # Ensure sliding window is full for failure_rate calculation
    breaker._transition_to(CircuitState.CLOSED)
    breaker._record_success(0.2)  # True
    breaker._record_failure(0.4)  # False
    breaker._record_success(0.6)  # True
    breaker._record_failure(0.8)  # False

    info = breaker.get_health_info()
    assert info["name"] == breaker.name
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert "failure_count" in info
    assert "success_count" in info
    assert info["failure_rate"] == pytest.approx(0.5)
    assert "metrics" in info and "config" in info

    metrics = info["metrics"]
    # Average of durations: (0.2 + 0.4 + 0.6 + 0.8) / 4 = 0.5 seconds => 500 ms
    assert metrics["average_response_time_ms"] == pytest.approx(500.0, abs=1e-6)


def test_circuit_breaker_execute_half_open_flow(breaker, monkeypatch):
    """Integration test: open -> half-open after timeout -> close after success_threshold successes."""
    # Configure to open on first failure
    breaker.config.failure_threshold = 1
    base = 6000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)

    # First failing call opens the circuit
    with pytest.raises(RuntimeError):
        breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
    assert breaker.state == CircuitState.OPEN

    # Advance time to trigger HALF_OPEN on next check
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds + 0.1)
    assert breaker.state == CircuitState.HALF_OPEN

    # Two successful trial calls -> should close
    assert breaker.execute(lambda: "ok") == "ok"
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.execute(lambda: "ok") == "ok"
    assert breaker.state == CircuitState.CLOSED


def test_coordinator_register_breaker_sends_registration(coordinator, breaker):
    """Test that register_breaker sends a registration HTTP request."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator.register_breaker(breaker)
        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert "/circuit-breakers/register" in req.full_url
        data = json.loads(req.data.decode("utf-8"))
        assert data["service"] == breaker.name
        assert "node_id" in data


def test_coordinator_register_breaker_handles_urlerror(coordinator, breaker):
    """Test that register_breaker suppresses URLError exceptions."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("should not leak")):
        # Should not raise
        coordinator.register_breaker(breaker)


def test_coordinator_synchronize_states_posts_state(coordinator, breaker):
    """Test _synchronize_states posts state updates for each registered breaker."""
    other = CircuitBreaker("other", config=breaker.config)
    coordinator.register_breaker(breaker)
    coordinator.register_breaker(other)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator._synchronize_states()
        assert mock_urlopen.call_count == 2
        urls = [mock_urlopen.call_args_list[0][0][0].full_url, mock_urlopen.call_args_list[1][0][0].full_url]
        assert all("/circuit-breakers/state" in u for u in urls)
        # Validate payload structure
        for call_args in mock_urlopen.call_args_list:
            req = call_args[0][0]
            payload = json.loads(req.data.decode("utf-8"))
            assert "service" in payload
            assert "node_id" in payload
            assert "state" in payload
            assert "failure_count" in payload
            assert "timestamp" in payload
            assert "health_info" in payload


def test_coordinator_start_and_stop_sync_runs_loop(coordinator, breaker, monkeypatch):
    """Test start_sync starts thread and stop_sync stops it; loop calls _synchronize_states."""
    coordinator.register_breaker(breaker)
    sync_mock = Mock()
    monkeypatch.setattr(coordinator, "_synchronize_states", sync_mock)
    coordinator.start_sync()
    time.sleep(0.03)
    coordinator.stop_sync()
    assert sync_mock.call_count >= 1
    assert not coordinator._running
    if coordinator._sync_thread:
        assert not coordinator._sync_thread.is_alive()


def test_coordinator_get_cluster_state_success(coordinator):
    """Test get_cluster_state returns parsed JSON on success."""
    response_data = {"state": "aggregate"}
    mock_resp = Mock()
    mock_resp.read.return_value = json.dumps(response_data).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=mock_resp):
        result = coordinator.get_cluster_state("svc")
        assert result == response_data


def test_coordinator_get_cluster_state_urlerror(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("network")):
        res = coordinator.get_cluster_state("svc")
        assert res["error"] == "Failed to fetch cluster state"


def test_decorator_circuit_breaker_executes_and_sets_attributes():
    """Test circuit_breaker decorator executes function and exposes breaker."""
    @circuit_breaker("decorated-service")
    def f(x, y):
        return x + y

    res = f(2, 3)
    assert res == 5
    assert hasattr(f, "circuit_breaker")
    br = f.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    assert br.metrics.total_calls == 1
    assert br.metrics.successful_calls == 1