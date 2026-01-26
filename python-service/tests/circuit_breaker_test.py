import json
import types
import pytest
from unittest.mock import Mock, patch, MagicMock

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
def reset_registry(monkeypatch):
    """Ensure CircuitBreaker registry is reset for each test to avoid cross-test interference."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {}, raising=False)


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig instance for tests."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Create a new CircuitBreaker instance with a unique name."""
    return CircuitBreaker(name="test-breaker", config=default_config)


def test_circuit_state_enum_values():
    """Test CircuitState enum contains expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test default values in CircuitBreakerConfig."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_metrics_record_response_time_average():
    """Test CircuitBreakerMetrics.record_response_time updates moving average."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    metrics.record_response_time(0.5)
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3 + 0.5) / 3)


def test_open_error_attributes_and_message():
    """Test CircuitBreakerOpenError attributes and message format."""
    err = CircuitBreakerOpenError(name="svc", remaining_time=2.5)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(2.5)
    assert "Circuit breaker 'svc' is open" in str(err)
    assert "2.50s" in str(err)


def test_circuit_breaker_get_or_create_singleton(default_config):
    """Test CircuitBreaker.get_or_create returns the same instance per name."""
    br1 = CircuitBreaker.get_or_create("singleton", default_config)
    br2 = CircuitBreaker.get_or_create("singleton", CircuitBreakerConfig(failure_threshold=1))
    assert br1 is br2
    assert br1.name == "singleton"


def test_circuit_breaker_initial_state_and_metrics(breaker):
    """Test initial state and metrics of a new CircuitBreaker."""
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.total_calls == 0
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.rejected_calls == 0
    assert breaker.metrics.state_transitions == 0


def test_circuit_breaker_execute_success_in_closed(breaker):
    """Test executing a successful operation in CLOSED state updates metrics."""
    result = breaker.execute(lambda: "ok")
    assert result == "ok"
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.average_response_time >= 0.0
    assert breaker.metrics.last_success_time is not None


def test_circuit_breaker_execute_failure_in_closed_increments_counts(breaker):
    """Test a failing operation increments failed_calls and does not open until threshold."""
    def op():
        raise ValueError("failure")

    with pytest.raises(ValueError):
        breaker.execute(op)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.last_failure_time is not None
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 1


def test_circuit_breaker_opens_after_failure_threshold():
    """Test breaker transitions to OPEN after reaching failure_threshold in CLOSED state."""
    cfg = CircuitBreakerConfig(failure_threshold=2, sliding_window_size=10, failure_rate_threshold=0.9)
    br = CircuitBreaker("threshold-breaker", cfg)

    def failing():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        br.execute(failing)
    assert br.state == CircuitState.CLOSED  # not yet open
    with pytest.raises(RuntimeError):
        br.execute(failing)

    assert br.state == CircuitState.OPEN
    assert br.metrics.state_transitions >= 1
    assert br._failure_count == 2
    assert br._opened_at is not None


def test_circuit_breaker_opens_due_to_failure_rate():
    """Test breaker opens due to failure rate once sliding window is full."""
    cfg = CircuitBreakerConfig(failure_threshold=100, sliding_window_size=4, failure_rate_threshold=0.5)
    br = CircuitBreaker("rate-breaker", cfg)

    def failing():
        raise RuntimeError("boom")

    for _ in range(3):
        with pytest.raises(RuntimeError):
            br.execute(failing)
        assert br.state == CircuitState.CLOSED  # window not full yet

    with pytest.raises(RuntimeError):
        br.execute(failing)

    assert br.state == CircuitState.OPEN
    assert br.metrics.failed_calls == 4
    assert br.metrics.state_transitions >= 1


def test_circuit_breaker_open_state_rejects_calls_without_fallback(monkeypatch):
    """Test that OPEN state rejects calls and raises CircuitBreakerOpenError with remaining time."""
    cfg = CircuitBreakerConfig(timeout_seconds=10.0)
    br = CircuitBreaker("open-reject", cfg)
    # Set to OPEN and set opened_at to 100
    br._transition_to(CircuitState.OPEN)
    # Force opened_at to a specific time
    br._opened_at = 100.0

    # Set current time to 105; remaining should be 5 seconds
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 105.0)

    with pytest.raises(CircuitBreakerOpenError) as excinfo:
        br.execute(lambda: "should not run")

    assert br.metrics.rejected_calls == 1
    err = excinfo.value
    assert err.name == "open-reject"
    assert err.remaining_time == pytest.approx(5.0)


def test_circuit_breaker_open_state_with_fallback_returns_value(monkeypatch):
    """Test that OPEN state with fallback returns fallback result and does not increment total_calls."""
    cfg = CircuitBreakerConfig(timeout_seconds=30.0)
    br = CircuitBreaker("open-fallback", cfg)
    br._transition_to(CircuitState.OPEN)
    br._opened_at = 100.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 110.0)

    op = Mock(return_value="operation")
    fallback = Mock(return_value="fallback")

    result = br.execute(op, fallback=fallback)
    assert result == "fallback"
    op.assert_not_called()
    fallback.assert_called_once()
    assert br.metrics.rejected_calls == 1
    assert br.metrics.total_calls == 0  # not incremented when rejected before execution


def test_circuit_breaker_auto_transitions_to_half_open_after_timeout(monkeypatch):
    """Test that accessing state transitions from OPEN to HALF_OPEN after timeout."""
    cfg = CircuitBreakerConfig(timeout_seconds=10.0)
    br = CircuitBreaker("reset-breaker", cfg)
    br._transition_to(CircuitState.OPEN)
    opened_at = 50.0
    br._opened_at = opened_at

    fake_now = opened_at + cfg.timeout_seconds + 0.1
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: fake_now)

    # Accessing state should trigger transition
    assert br.state == CircuitState.HALF_OPEN
    assert br.metrics.state_transitions >= 2  # OPEN -> HALF_OPEN is a transition
    assert br._half_open_calls == 0
    assert br._success_count == 0


def test_circuit_breaker_half_open_allows_limited_calls_and_blocks_after_limit(monkeypatch):
    """Test HALF_OPEN allows up to half_open_max_calls and then rejects further calls if threshold not met."""
    cfg = CircuitBreakerConfig(timeout_seconds=1.0, half_open_max_calls=2, success_threshold=5)
    br = CircuitBreaker("half-open-limit", cfg)

    # Move to OPEN and set time to trigger HALF_OPEN on next check
    br._transition_to(CircuitState.OPEN)
    br._opened_at = 0.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 100.0)

    # First call transitions to HALF_OPEN and succeeds
    res1 = br.execute(lambda: "ok1")
    assert res1 == "ok1"
    assert br.state == CircuitState.HALF_OPEN
    assert br._success_count == 1

    # Second allowed call succeeds
    res2 = br.execute(lambda: "ok2")
    assert res2 == "ok2"
    assert br.state == CircuitState.HALF_OPEN
    assert br._success_count == 2

    # Third call should be rejected due to half_open_max_calls reached
    with pytest.raises(CircuitBreakerOpenError) as excinfo:
        br.execute(lambda: "blocked")
    assert br.metrics.rejected_calls == 1
    # remaining time in error is based on opened_at; since opened_at was 0 and now time is 100, remaining will be clamped to 0
    assert excinfo.value.remaining_time == pytest.approx(0.0)


def test_circuit_breaker_half_open_failure_transitions_to_open(monkeypatch):
    """Test that a failure in HALF_OPEN transitions back to OPEN."""
    cfg = CircuitBreakerConfig(timeout_seconds=1.0, half_open_max_calls=3, success_threshold=2)
    br = CircuitBreaker("half-open-fail", cfg)

    br._transition_to(CircuitState.OPEN)
    br._opened_at = 0.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 100.0)

    def failing():
        raise RuntimeError("fail")

    with pytest.raises(RuntimeError):
        br.execute(failing)

    assert br.state == CircuitState.OPEN
    assert br.metrics.state_transitions >= 2  # OPEN -> HALF_OPEN -> OPEN


def test_circuit_breaker_record_success_decrements_failure_count():
    """Test that a success in CLOSED decrements the failure_count."""
    cfg = CircuitBreakerConfig(failure_threshold=100, sliding_window_size=10)
    br = CircuitBreaker("success-decrement", cfg)

    def failing():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        br.execute(failing)
    with pytest.raises(RuntimeError):
        br.execute(failing)
    assert br._failure_count == 2

    br.execute(lambda: "ok")
    assert br._failure_count == 1  # decremented by one


def test_circuit_breaker_calculate_failure_rate_behavior():
    """Test _calculate_failure_rate returns 0.0 until window full, then correct ratio."""
    cfg = CircuitBreakerConfig(sliding_window_size=4)
    br = CircuitBreaker("rate-calc", cfg)

    # Append less than window size entries
    br._sliding_window.append(True)
    br._sliding_window.append(False)
    assert br._calculate_failure_rate() == pytest.approx(0.0)

    # Fill to window size with known values: [True, False, False, True] -> 2/4 failures
    br._sliding_window.append(False)
    br._sliding_window.append(True)
    assert br._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_should_attempt_reset(monkeypatch):
    """Test _should_attempt_reset based on time elapsed since OPEN."""
    cfg = CircuitBreakerConfig(timeout_seconds=30.0)
    br = CircuitBreaker("reset-check", cfg)

    # Not opened yet
    assert br._should_attempt_reset() is False

    br._transition_to(CircuitState.OPEN)
    br._opened_at = 100.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 120.0)
    assert br._should_attempt_reset() is False

    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 131.0)
    assert br._should_attempt_reset() is True


def test_circuit_breaker_transition_to_sets_fields(monkeypatch):
    """Test _transition_to updates internal fields and metrics correctly."""
    br = CircuitBreaker("transition-test", CircuitBreakerConfig())

    # Transition to OPEN sets _opened_at
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 123.456)
    br._transition_to(CircuitState.OPEN)
    assert br._opened_at == pytest.approx(123.456)
    assert br.metrics.state_transitions == 1

    # Transition to HALF_OPEN resets counts but does not change _opened_at
    br._failure_count = 3
    br._success_count = 2
    br._half_open_calls = 5
    br._transition_to(CircuitState.HALF_OPEN)
    assert br._success_count == 0
    assert br._half_open_calls == 0
    assert br._opened_at == pytest.approx(123.456)
    assert br.metrics.state_transitions == 2

    # Populate sliding window then transition to CLOSED clears counts and window and clears _opened_at
    br._sliding_window.append(True)
    br._sliding_window.append(False)
    br._transition_to(CircuitState.CLOSED)
    assert br._failure_count == 0
    assert br._success_count == 0
    assert br._opened_at is None
    assert len(br._sliding_window) == 0
    assert br.metrics.state_transitions == 3


def test_circuit_breaker_allow_request_logic(monkeypatch):
    """Test _allow_request behavior across states."""
    cfg = CircuitBreakerConfig(half_open_max_calls=2, timeout_seconds=100.0)
    br = CircuitBreaker("allow-request", cfg)

    # CLOSED -> True
    assert br._allow_request() is True

    # OPEN -> False (and not reset as timeout not elapsed)
    br._transition_to(CircuitState.OPEN)
    br._opened_at = 0.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: 50.0)
    assert br._allow_request() is False

    # HALF_OPEN with limit
    br._transition_to(CircuitState.HALF_OPEN)
    assert br._allow_request() is True
    assert br._half_open_calls == 1
    assert br._allow_request() is True
    assert br._half_open_calls == 2
    assert br._allow_request() is False  # exceeded


def test_circuit_breaker_get_health_info(breaker):
    """Test get_health_info returns expected structure and values."""
    # Execute a couple of operations
    breaker.execute(lambda: "ok")
    with pytest.raises(RuntimeError):
        breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))

    info = breaker.get_health_info()
    assert info["name"] == "test-breaker"
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert "failure_count" in info
    assert "success_count" in info
    assert "failure_rate" in info
    assert "metrics" in info
    assert "config" in info

    metrics = info["metrics"]
    assert metrics["total_calls"] == 2
    assert metrics["successful_calls"] == 1
    assert metrics["failed_calls"] == 1
    assert metrics["rejected_calls"] >= 0
    assert metrics["average_response_time_ms"] >= 0.0
    assert metrics["state_transitions"] >= 0

    config = info["config"]
    assert config["failure_threshold"] == breaker.config.failure_threshold
    assert config["success_threshold"] == breaker.config.success_threshold
    assert config["timeout_seconds"] == pytest.approx(breaker.config.timeout_seconds)


def test_coordinator_register_breaker_sends_registration_success(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator.register_breaker sends registration successfully."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    br = CircuitBreaker("svc", CircuitBreakerConfig())

    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)

    coord.register_breaker(br)
    assert "svc" in coord._breakers
    assert mock_urlopen.called


def test_coordinator_register_breaker_sends_registration_handles_error(monkeypatch):
    """Test _send_registration gracefully handles URLError without raising."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    br = CircuitBreaker("svc2", CircuitBreakerConfig())

    def raise_url_error(req, timeout=5):
        raise Exception("This should be URLError")

    # Using urllib.error.URLError specifically
    from urllib.error import URLError

    def raise_urle(req, timeout=5):
        raise URLError("network")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urle)

    # Should not raise
    coord.register_breaker(br)
    assert "svc2" in coord._breakers


def test_coordinator_start_and_stop_sync_runs_thread(monkeypatch):
    """Test start_sync initiates background thread and stop_sync stops it."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    br = CircuitBreaker("svc3", CircuitBreakerConfig())
    coord.register_breaker(br)

    call_count = {"n": 0}

    def fake_sync():
        call_count["n"] += 1

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)

    coord.start_sync()
    # Allow some time for thread to run
    import time as _time
    _time.sleep(0.05)
    assert coord._sync_thread is not None
    assert coord._sync_thread.is_alive()
    assert call_count["n"] > 0

    coord.stop_sync()
    assert coord._running is False
    # Give time to join
    _time.sleep(0.02)
    assert coord._sync_thread is None or not coord._sync_thread.is_alive()


def test_coordinator_synchronize_states_posts_state(monkeypatch):
    """Test _synchronize_states posts state data for each registered breaker."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    cfg = CircuitBreakerConfig()
    br = CircuitBreaker("svc4", cfg)
    coord.register_breaker(br)

    captured = []

    class DummyResponse:
        def read(self):
            return b"ok"

    def capture_request(req, timeout=5):
        captured.append(req)
        return DummyResponse()

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", capture_request)

    # Ensure breaker is in a known state
    br._transition_to(CircuitState.OPEN)
    coord._synchronize_states()

    assert len(captured) == 1
    req = captured[0]
    assert req.full_url.endswith("/circuit-breakers/state")
    data = json.loads(req.data.decode("utf-8"))
    assert data["service"] == "svc4"
    assert data["state"] in {"OPEN", "CLOSED", "HALF_OPEN"}
    assert "health_info" in data
    assert data["health_info"]["name"] == "svc4"


def test_coordinator_synchronize_states_handles_url_error(monkeypatch):
    """Test _synchronize_states ignores URLError exceptions."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    br = CircuitBreaker("svc5", CircuitBreakerConfig())
    coord.register_breaker(br)

    from urllib.error import URLError

    def raise_urle(req, timeout=5):
        raise URLError("network")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urle)

    # Should not raise
    coord._synchronize_states()


def test_coordinator_get_cluster_state_success(monkeypatch):
    """Test get_cluster_state returns parsed JSON on success."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")

    expected = {"state": "aggregate", "nodes": {"a": "OPEN"}}

    class DummyResponse:
        def read(self):
            return json.dumps(expected).encode("utf-8")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", lambda req, timeout=5: DummyResponse())
    result = coord.get_cluster_state("svc")
    assert result == expected


def test_coordinator_get_cluster_state_error(monkeypatch):
    """Test get_cluster_state returns error dict when urlopen raises URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    from urllib.error import URLError

    def raise_urle(req, timeout=5):
        raise URLError("network")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urle)
    result = coord.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}


def test_decorator_circuit_breaker_wraps_function_and_tracks_metrics():
    """Test circuit_breaker decorator wraps function and uses shared breaker instance."""
    calls = {"n": 0}

    @circuit_breaker("decorator-test")
    def my_func(x):
        calls["n"] += 1
        return x * 2

    result1 = my_func(3)
    result2 = my_func(5)
    assert result1 == 6
    assert result2 == 10
    assert calls["n"] == 2

    # Validate breaker metadata on wrapper
    assert hasattr(my_func, "circuit_breaker")
    br = my_func.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    assert br.name == "decorator-test"
    assert br.metrics.total_calls == 2

    # Ensure wrapper.__wrapped__ points to original function
    assert getattr(my_func, "__wrapped__", None) is not None
    assert my_func.__wrapped__(4) == 8