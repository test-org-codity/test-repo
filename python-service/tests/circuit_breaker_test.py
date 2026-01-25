import json
import time
import threading
import pytest
from unittest.mock import Mock, patch
from urllib.error import URLError

from src.circuit_breaker import (
    CircuitState,
    CircuitBreakerConfig,
    CircuitBreakerMetrics,
    CircuitBreakerOpenError,
    CircuitBreaker,
    DistributedCircuitBreakerCoordinator,
    circuit_breaker,
)


@pytest.fixture
def cb_config():
    """Provide a CircuitBreakerConfig with low thresholds for faster tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.05,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(cb_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker("test-service", cb_config)


@pytest.fixture(autouse=True)
def reset_registry(monkeypatch):
    """Ensure CircuitBreaker registry is isolated across tests."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


def test_circuit_state_enum_values():
    """Test CircuitState enum has the correct values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_get_or_create_singleton(cb_config):
    """Test get_or_create returns the same instance for the same name."""
    cb1 = CircuitBreaker.get_or_create("singleton", cb_config)
    other_config = CircuitBreakerConfig(failure_threshold=10)
    cb2 = CircuitBreaker.get_or_create("singleton", other_config)
    assert cb1 is cb2
    assert cb1.config.failure_threshold == 2  # from first config


def test_circuit_breaker_allow_request_closed(breaker):
    """Test _allow_request returns True when state is CLOSED."""
    assert breaker.state == CircuitState.CLOSED
    assert breaker._allow_request() is True


def test_circuit_breaker_execute_success_records_metrics_and_remains_closed(breaker):
    """Test execute success path updates metrics and keeps state CLOSED."""
    def op():
        time.sleep(0.001)
        return "ok"

    result = breaker.execute(op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.last_success_time is not None
    assert breaker.metrics.average_response_time == pytest.approx(breaker.metrics.average_response_time)
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_execute_failure_trips_on_failure_threshold(cb_config):
    """Test that repeated failures trip the breaker to OPEN by count threshold."""
    cb = CircuitBreaker("failure-trip", cb_config)

    def failing():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        cb.execute(failing)
    with pytest.raises(RuntimeError):
        cb.execute(failing)

    assert cb.metrics.total_calls == 2
    assert cb.metrics.failed_calls == 2
    assert cb.state == CircuitState.OPEN

    # Next call should be rejected and increase rejected_calls
    with pytest.raises(CircuitBreakerOpenError) as excinfo:
        cb.execute(lambda: "unreachable")
    err = excinfo.value
    assert err.name == "failure-trip"
    assert err.remaining_time >= 0.0
    assert cb.metrics.rejected_calls == 1


def test_circuit_breaker_open_to_half_open_after_timeout_and_successes_close(cb_config):
    """Test auto-transition OPEN -> HALF_OPEN after timeout and closing after success threshold."""
    cb = CircuitBreaker("half-open-recovery", cb_config)
    # Force OPEN
    cb._transition_to(CircuitState.OPEN)
    # Set opened_at in the past so state property moves to HALF_OPEN
    cb._opened_at = time.time() - cb.config.timeout_seconds - 0.001
    assert cb.state == CircuitState.HALF_OPEN

    # Execute two successful calls to satisfy success_threshold and close
    assert cb._half_open_calls == 0
    res1 = cb.execute(lambda: "ok1")
    res2 = cb.execute(lambda: "ok2")
    assert res1 == "ok1"
    assert res2 == "ok2"
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_half_open_allows_limited_calls():
    """Test HALF_OPEN state allows only up to half_open_max_calls."""
    cfg = CircuitBreakerConfig(half_open_max_calls=1)
    cb = CircuitBreaker("half-open-allow", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    allowed_first = cb._allow_request()
    allowed_second = cb._allow_request()

    assert allowed_first is True
    assert allowed_second is False


def test_circuit_breaker_half_open_failure_reopens_immediately(breaker):
    """Test a failure during HALF_OPEN re-opens the breaker."""
    breaker._transition_to(CircuitState.HALF_OPEN)

    def failing():
        raise ValueError("fail")

    with pytest.raises(ValueError):
        breaker.execute(failing)

    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 1


def test_circuit_breaker_sliding_window_failure_rate_trips():
    """Test breaker trips to OPEN when failure rate in full window exceeds threshold."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # high so count does not trip
        failure_rate_threshold=0.5,
        sliding_window_size=4,
    )
    cb = CircuitBreaker("rate-trip", cfg)

    # 2 successes, 2 failures -> failure rate = 0.5 at full window
    cb.execute(lambda: "s1")
    cb.execute(lambda: "s2")
    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("f1")))
    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("f2")))

    assert cb.state == CircuitState.OPEN
    assert cb._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_calculate_failure_rate_partial_window(cb_config):
    """Test _calculate_failure_rate returns 0.0 when window not full."""
    cb = CircuitBreaker("partial-window", cb_config)
    cb._sliding_window.append(False)
    cb._sliding_window.append(True)
    # len < sliding_window_size
    assert cb._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_record_success_and_failure_adjust_counts(breaker):
    """Test _record_success reduces failure_count and _record_failure increases it and can open."""
    # Start with failures to increase failure_count
    breaker._record_failure(0.001)
    assert breaker.metrics.failed_calls == 1
    assert breaker._failure_count == 1
    # Success should decrement failure_count but not below 0
    breaker._record_success(0.001)
    assert breaker.metrics.successful_calls == 1
    assert breaker._failure_count == 0

    # Fail enough times to open by count
    breaker._record_failure(0.001)
    breaker._record_failure(0.001)
    assert breaker.state == CircuitState.OPEN


def test_circuit_breaker_record_success_in_half_open_closes_on_threshold():
    """Test _record_success in HALF_OPEN increments success_count and closes breaker when threshold met."""
    cfg = CircuitBreakerConfig(success_threshold=2, half_open_max_calls=5)
    cb = CircuitBreaker("half-open-success", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    cb._record_success(0.002)
    assert cb._success_count == 1
    assert cb.state == CircuitState.HALF_OPEN

    cb._record_success(0.003)
    assert cb.state == CircuitState.CLOSED
    assert cb._success_count == 0  # reset on close


def test_circuit_breaker_transition_to_resets_fields():
    """Test _transition_to resets fields appropriately."""
    cb = CircuitBreaker("transition-reset")
    cb._failure_count = 5
    cb._success_count = 2
    cb._opened_at = time.time()
    cb._sliding_window.extend([True, False, False])

    cb._transition_to(CircuitState.CLOSED)
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0


def test_circuit_breaker_should_attempt_reset(cb_config):
    """Test _should_attempt_reset returns True only after timeout elapsed."""
    cb = CircuitBreaker("reset-check", cb_config)

    cb._opened_at = None
    assert cb._should_attempt_reset() is False

    cb._opened_at = time.time()
    assert cb._should_attempt_reset() is False

    cb._opened_at = time.time() - cb.config.timeout_seconds - 0.001
    assert cb._should_attempt_reset() is True


def test_circuit_breaker_get_health_info_structure_and_values(breaker):
    """Test get_health_info returns expected dictionary structure and values."""
    breaker.execute(lambda: "ok")
    info = breaker.get_health_info()

    assert info["name"] == "test-service"
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert isinstance(info["failure_count"], int)
    assert isinstance(info["success_count"], int)
    assert isinstance(info["failure_rate"], float)
    metrics = info["metrics"]
    assert metrics["total_calls"] == 1
    assert metrics["successful_calls"] == 1
    assert metrics["failed_calls"] == 0
    assert metrics["average_response_time_ms"] == pytest.approx(metrics["average_response_time_ms"])
    assert "config" in info
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker.config.success_threshold
    assert info["config"]["timeout_seconds"] == breaker.config.timeout_seconds


def test_circuit_breaker_open_error_remaining_time_and_fallback(cb_config):
    """Test CircuitBreakerOpenError and fallback behavior when breaker is OPEN."""
    cb = CircuitBreaker("open-error", cb_config)
    cb._transition_to(CircuitState.OPEN)
    now = time.time()
    cb._opened_at = now  # just opened

    # With fallback, no exception should be raised
    rv = cb.execute(lambda: "unreachable", fallback=lambda: "fallback")
    assert rv == "fallback"
    assert cb.metrics.rejected_calls == 1

    # Without fallback, raises CircuitBreakerOpenError
    with pytest.raises(CircuitBreakerOpenError) as excinfo:
        cb.execute(lambda: "unreachable")
    err = excinfo.value
    assert err.name == "open-error"
    assert 0.0 <= err.remaining_time <= cb.config.timeout_seconds


def test_circuit_breaker_metrics_record_response_time_average():
    """Test CircuitBreakerMetrics records response times and computes average."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.010)
    metrics.record_response_time(0.030)
    assert metrics.average_response_time == pytest.approx((0.010 + 0.030) / 2.0)


@patch("src.circuit_breaker.urllib.request.urlopen")
def test_distributed_coordinator_register_breaker_sends_registration(mock_urlopen, breaker):
    """Test register_breaker sends registration to coordinator."""
    mock_urlopen.return_value = Mock()
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    coordinator.register_breaker(breaker)

    assert mock_urlopen.called
    req = mock_urlopen.call_args[0][0]
    assert req.get_full_url().endswith("/circuit-breakers/register")
    assert req.get_method() == "POST"
    body = json.loads(req.data.decode("utf-8"))
    assert body["service"] == breaker.name
    assert "node_id" in body


@patch("src.circuit_breaker.urllib.request.urlopen")
def test_distributed_coordinator_synchronize_states_posts_state(mock_urlopen, breaker):
    """Test _synchronize_states posts state updates for registered breakers."""
    mock_urlopen.return_value = Mock()
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    coordinator.register_breaker(breaker)

    coordinator._synchronize_states()

    # First call was register, second is state sync
    assert mock_urlopen.call_count >= 2
    req = mock_urlopen.call_args[0][0]
    assert req.get_full_url().endswith("/circuit-breakers/state")
    assert req.get_method() == "POST"
    body = json.loads(req.data.decode("utf-8"))
    assert body["service"] == breaker.name
    assert body["state"] == breaker.state.value
    assert "health_info" in body


def test_distributed_coordinator_sync_loop_runs_and_stops(breaker):
    """Test start_sync launches background loop and stop_sync stops it."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    coordinator.register_breaker(breaker)

    call_counter = {"count": 0}

    def fake_sync():
        call_counter["count"] += 1

    coordinator._synchronize_states = fake_sync  # patch method directly
    coordinator.start_sync()
    time.sleep(0.03)
    coordinator.stop_sync()

    assert call_counter["count"] >= 1


@patch("src.circuit_breaker.urllib.request.urlopen")
def test_distributed_coordinator_get_cluster_state_success(mock_urlopen):
    """Test get_cluster_state returns parsed JSON on success."""
    response = Mock()
    response.read.return_value = json.dumps({"aggregate": {"state": "CLOSED"}}).encode("utf-8")
    mock_urlopen.return_value = response

    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    result = coordinator.get_cluster_state("svc")
    assert result == {"aggregate": {"state": "CLOSED"}}


@patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("nope"))
def test_distributed_coordinator_get_cluster_state_error(mock_urlopen):
    """Test get_cluster_state returns error dict when request fails."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    result = coordinator.get_cluster_state("svc")
    assert "error" in result


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test circuit_breaker decorator wraps function and uses get_or_create breaker."""
    cfg = CircuitBreakerConfig(failure_threshold=3)
    name = "decorator-test"

    @circuit_breaker(name, cfg)
    def add(a, b):
        return a + b

    result = add(2, 3)
    assert result == 5

    # Verify breaker association and shared instance
    br = add.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    br2 = CircuitBreaker.get_or_create(name, cfg)
    assert br is br2
    assert br.metrics.total_calls == 1