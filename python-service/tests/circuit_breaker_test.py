import json
import threading
import types
from typing import Any
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
    """Reset CircuitBreaker registry between tests to avoid cross-test contamination."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def small_config():
    """Provide a CircuitBreakerConfig with small thresholds for faster testing."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=5.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(small_config):
    """Create a CircuitBreaker with a small config."""
    return CircuitBreaker(name="test-breaker", config=small_config)


def test_circuit_state_enum_values():
    """Ensure CircuitState enum has the expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Verify default configuration values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuit_breaker_metrics_record_response_time():
    """Test that record_response_time updates average and stores times."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    assert m.average_response_time == pytest.approx(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)
    assert len(m._response_times) == 2
    # Ensure deque maxlen is 100
    for _ in range(200):
        m.record_response_time(0.01)
    assert len(m._response_times) <= 100


def test_circuit_breaker_get_or_create_singleton():
    """get_or_create should return the same instance for the same name."""
    cfg = CircuitBreakerConfig(failure_threshold=3)
    a1 = CircuitBreaker.get_or_create("shared", cfg)
    a2 = CircuitBreaker.get_or_create("shared", cfg)
    b = CircuitBreaker.get_or_create("other", cfg)
    assert a1 is a2
    assert a1 is not b
    assert a1.config.failure_threshold == 3


def test_circuit_breaker_state_transitions_half_open_after_timeout(breaker, monkeypatch):
    """OPEN should transition to HALF_OPEN after timeout when accessing state property."""
    current = [1000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    # Move to OPEN and verify
    breaker._transition_to(CircuitState.OPEN)
    assert breaker.state == CircuitState.OPEN

    # After timeout_seconds elapsed, state property should cause HALF_OPEN transition
    current[0] += breaker.config.timeout_seconds
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions >= 2  # OPEN and then HALF_OPEN


def test_circuit_breaker_should_attempt_reset_logic(breaker, monkeypatch):
    """_should_attempt_reset should reflect elapsed time since open."""
    current = [2000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    breaker._opened_at = current[0] - (breaker.config.timeout_seconds - 1)
    assert breaker._should_attempt_reset() is False

    breaker._opened_at = current[0] - (breaker.config.timeout_seconds + 1)
    assert breaker._should_attempt_reset() is True


def test_circuit_breaker_transition_to_sets_and_resets_fields(breaker, monkeypatch):
    """_transition_to should correctly set internal fields depending on state."""
    current = [3000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    # Prepare some internal state
    breaker._failure_count = 5
    breaker._success_count = 2
    breaker._sliding_window.extend([True, False, True])
    # Transition to CLOSED should reset counters and sliding window
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0

    # Transition to OPEN should set opened_at
    breaker._transition_to(CircuitState.OPEN)
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(current[0])

    # Transition to HALF_OPEN should reset half-open counters
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0


def test_circuit_breaker_execute_success_updates_metrics_and_window(breaker, monkeypatch):
    """execute records successful call metrics and updates sliding window."""
    current = [4000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    def op():
        current[0] += 0.05
        return "ok"

    result = breaker.execute(op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.05)
    assert breaker._sliding_window[-1] is True
    assert breaker._failure_count == 0
    assert breaker.metrics.last_success_time == pytest.approx(current[0])


def test_circuit_breaker_execute_failure_in_closed_trips_after_threshold(breaker, monkeypatch):
    """Failures should increment failure count and open after reaching threshold."""
    current = [5000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    def fail():
        current[0] += 0.01
        raise ValueError("boom")

    with pytest.raises(ValueError):
        breaker.execute(fail)
    assert breaker._failure_count == 1
    assert breaker.state == CircuitState.CLOSED

    with pytest.raises(ValueError):
        breaker.execute(fail)
    assert breaker._failure_count == 2
    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 2


def test_circuit_breaker_failure_rate_trips_open(monkeypatch):
    """Breaker should open when failure rate in a full window exceeds threshold."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # high to avoid count-based open
        success_threshold=1,
        timeout_seconds=5.0,
        half_open_max_calls=1,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("rate-breaker", cfg)
    current = [6000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    def ok():
        current[0] += 0.01
        return True

    def fail():
        current[0] += 0.01
        raise RuntimeError("x")

    # Fill window: 2 successes, then 2 failures
    assert br.state == CircuitState.CLOSED
    assert br.execute(ok) is True
    with pytest.raises(RuntimeError):
        br.execute(fail)
    assert br.state == CircuitState.CLOSED
    assert br.execute(ok) is True
    with pytest.raises(RuntimeError):
        br.execute(fail)

    # Now window is full; failure rate should be 0.5 and breaker should be OPEN
    rate = br._calculate_failure_rate()
    assert rate == pytest.approx(0.5)
    assert br.state == CircuitState.OPEN


def test_circuit_breaker_allow_request_in_half_open_limits_calls(breaker):
    """In HALF_OPEN, allow only up to half_open_max_calls requests."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    allowed = [breaker._allow_request() for _ in range(3)]
    assert allowed[0] is True
    assert allowed[1] is True
    assert allowed[2] is False
    assert breaker._half_open_calls == 2


def test_circuit_breaker_record_success_half_open_closes_after_threshold(breaker, monkeypatch):
    """In HALF_OPEN, enough successes should transition to CLOSED."""
    current = [7000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_success(0.02)
    assert breaker.state == CircuitState.HALF_OPEN
    breaker._record_success(0.03)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker.metrics.successful_calls == 2
    assert breaker.metrics.average_response_time == pytest.approx((0.02 + 0.03) / 2.0)


def test_circuit_breaker_record_failure_half_open_opens_immediately(breaker, monkeypatch):
    """Any failure in HALF_OPEN should immediately transition to OPEN."""
    current = [8000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_failure(0.01)
    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 1


def test_circuit_breaker_calculate_failure_rate_values(breaker):
    """_calculate_failure_rate should be 0 when window not full and correct when full."""
    # Not full
    breaker._sliding_window.extend([True, False])
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)
    # Fill to size
    breaker._sliding_window.extend([False, True])  # now size == sliding_window_size (4)
    assert breaker._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_structure_and_values(breaker, monkeypatch):
    """get_health_info should return expected keys and values."""
    current = [9000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    # Two successes with known durations
    def op():
        current[0] += 0.02
        return "ok"

    breaker.execute(op)
    breaker.execute(op)

    info = breaker.get_health_info()
    assert info["name"] == "test-breaker"
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}  # likely CLOSED here
    assert "failure_count" in info and "success_count" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 2
    assert info["metrics"]["failed_calls"] == 0
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(20.0)  # 0.02s * 1000
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold


def test_circuit_breaker_execute_open_with_fallback_and_without(breaker, monkeypatch):
    """When OPEN, execute should call fallback or raise CircuitBreakerOpenError with remaining time."""
    current = [10000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    # Move to OPEN at t0
    breaker._transition_to(CircuitState.OPEN)
    t0 = current[0]

    # With fallback
    fb = lambda: "fallback"
    result = breaker.execute(lambda: "should-not-run", fallback=fb)
    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1

    # Without fallback -> should raise with remaining_time
    current[0] = t0 + 2.0  # 2 seconds elapsed
    with pytest.raises(CircuitBreakerOpenError) as ei:
        breaker.execute(lambda: "x")
    err = ei.value
    assert err.name == breaker.name
    expected_remaining = breaker.config.timeout_seconds - 2.0
    assert err.remaining_time == pytest.approx(expected_remaining, abs=1e-6)


def test_circuit_breaker_decorator_wraps_and_uses_shared_breaker(monkeypatch):
    """Decorator should execute via shared breaker and expose circuit_breaker attribute."""
    current = [11000.0]
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: current[0])

    @circuit_breaker("decor-test")
    def sample(x, y):
        current[0] += 0.01
        return x + y

    assert hasattr(sample, "circuit_breaker")
    shared = sample.circuit_breaker
    assert isinstance(shared, CircuitBreaker)
    assert shared.name == "decor-test"

    # Call decorated function
    assert sample(2, 3) == 5
    assert shared.metrics.total_calls == 1
    assert shared.metrics.successful_calls == 1


def test_distributed_coordinator_register_breaker_sends_registration(breaker, monkeypatch):
    """register_breaker should send registration POST to coordinator URL."""
    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator")
    coord.register_breaker(breaker)

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/register"
    data = json.loads(req.data.decode("utf-8"))
    assert data["service"] == breaker.name
    assert "node_id" in data
    assert data["failure_threshold"] == breaker.config.failure_threshold
    assert data["success_threshold"] == breaker.config.success_threshold


def test_distributed_coordinator_send_registration_handles_urlerror(breaker, monkeypatch):
    """_send_registration should swallow URLError exceptions."""
    from urllib.error import URLError

    def raise_err(*args, **kwargs):
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_err)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator")
    # Should not raise
    coord.register_breaker(breaker)


def test_distributed_coordinator_start_stop_sync_loop_invokes_synchronize_once(monkeypatch):
    """start_sync should spawn a thread that invokes _synchronize_states; stop_sync should stop it."""
    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator", sync_interval=0.01)

    called = {"count": 0}

    def sync_and_stop():
        called["count"] += 1
        coord._running = False

    monkeypatch.setattr(coord, "_synchronize_states", sync_and_stop)
    monkeypatch.setattr("src.circuit_breaker.time.sleep", lambda *_: None)

    coord.start_sync()
    coord.stop_sync()
    assert called["count"] >= 1


def test_distributed_coordinator_synchronize_states_posts_per_breaker(monkeypatch):
    """_synchronize_states should POST state for each registered breaker."""
    posted = []

    class DummyResponse:
        def read(self):
            return b"OK"

    def fake_urlopen(req, timeout=5):
        posted.append(req)
        return DummyResponse()

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator")
    # Directly register breakers to avoid registration POST
    b1 = CircuitBreaker("svc1")
    b2 = CircuitBreaker("svc2")
    coord._breakers[b1.name] = b1
    coord._breakers[b2.name] = b2

    coord._synchronize_states()
    # Should have posted for both breakers
    assert len(posted) == 2
    urls = [req.full_url for req in posted]
    assert urls == ["http://coordinator/circuit-breakers/state", "http://coordinator/circuit-breakers/state"]
    # Validate payloads
    payloads = [json.loads(req.data.decode("utf-8")) for req in posted]
    names = {p["service"] for p in payloads}
    assert names == {"svc1", "svc2"}
    for p in payloads:
        assert "node_id" in p
        assert p["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
        assert "health_info" in p and isinstance(p["health_info"], dict)


def test_distributed_coordinator_get_cluster_state_success_and_error(monkeypatch):
    """get_cluster_state should return parsed JSON on success and error dict on failure."""
    # Success case
    class Resp:
        def read(self):
            return json.dumps({"aggregate": "CLOSED", "nodes": {}}).encode("utf-8")

    mock_urlopen = Mock(return_value=Resp())
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator")
    result = coord.get_cluster_state("svc")
    assert result == {"aggregate": "CLOSED", "nodes": {}}
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/svc/aggregate"

    # Error case
    from urllib.error import URLError

    def raise_err(*args, **kwargs):
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_err)
    result_err = coord.get_cluster_state("svc")
    assert "error" in result_err