import json
import os
import threading
import time
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
import urllib.error

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
def config_small():
    """Provide a small configuration for quick state transitions."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.1,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def unique_name():
    """Provide a unique name to avoid registry collisions."""
    return f"svc-{uuid.uuid4()}"


@pytest.fixture
def breaker(config_small, unique_name):
    """Create a fresh CircuitBreaker instance for testing."""
    return CircuitBreaker(name=unique_name, config=config_small)


def test_circuitstate_enum_values():
    """Test CircuitState enum values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuitbreakerconfig_defaults():
    """Test CircuitBreakerConfig default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuitbreaker_metrics_record_response_time_average():
    """Test CircuitBreakerMetrics record_response_time updates average correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuitbreaker_open_error_properties_and_message():
    """Test CircuitBreakerOpenError contains correct properties and message."""
    err = CircuitBreakerOpenError(name="test", remaining_time=1.2345)
    assert err.name == "test"
    assert err.remaining_time == pytest.approx(1.2345)
    assert "Circuit breaker 'test' is open. Retry after" in str(err)


def test_circuitbreaker_get_or_create_singleton_per_name(config_small):
    """Test get_or_create returns the same instance for the same name."""
    name = f"payments-{uuid.uuid4()}"
    first = CircuitBreaker.get_or_create(name, config_small)
    second = CircuitBreaker.get_or_create(name, CircuitBreakerConfig(failure_threshold=99))
    assert first is second
    # Ensure the config is from the first creation
    assert first.config.failure_threshold == config_small.failure_threshold


def test_circuitbreaker_execute_success_in_closed_updates_metrics(breaker):
    """Test successful execute in CLOSED state updates metrics and remains CLOSED."""
    def op():
        return "ok"
    result = breaker.execute(op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.state == CircuitState.CLOSED


def test_circuitbreaker_execute_failure_opens_after_threshold(breaker):
    """Test consecutive failures trigger transition to OPEN after threshold."""
    def failing():
        raise RuntimeError("boom")
    with pytest.raises(RuntimeError):
        breaker.execute(failing)
    with pytest.raises(RuntimeError):
        breaker.execute(failing)
    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 2
    assert breaker.metrics.state_transitions >= 1
    assert breaker._opened_at is not None


def test_circuitbreaker_state_transitions_to_half_open_after_timeout(breaker, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN after timeout expires."""
    # Open the breaker
    def failing():
        raise RuntimeError("boom")
    for _ in range(breaker.config.failure_threshold):
        with pytest.raises(RuntimeError):
            breaker.execute(failing)
    assert breaker.state == CircuitState.OPEN
    opened_at = breaker._opened_at

    # Move time forward beyond timeout
    fake_now = opened_at + breaker.config.timeout_seconds + 0.001
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: fake_now)

    transitions_before = breaker.metrics.state_transitions
    # Accessing state should trigger HALF_OPEN transition
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions == transitions_before + 1


def test_circuitbreaker_half_open_allows_limited_calls_and_closes_on_success_threshold(monkeypatch):
    """Test HALF_OPEN allows limited calls and transitions to CLOSED on sufficient successes."""
    cfg = CircuitBreakerConfig(
        failure_threshold=1,
        success_threshold=2,
        timeout_seconds=0.01,
        half_open_max_calls=2,
        sliding_window_size=2,
        failure_rate_threshold=1.0,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # Force OPEN
    def failing():
        raise RuntimeError("x")
    with pytest.raises(RuntimeError):
        br.execute(failing)
    assert br.state == CircuitState.OPEN

    # Move to HALF_OPEN
    opened_at = br._opened_at
    now = opened_at + cfg.timeout_seconds + 0.001
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: now)
    assert br.state == CircuitState.HALF_OPEN

    # Two successful attempts should close the breaker
    assert br.execute(lambda: "ok") == "ok"
    assert br.execute(lambda: "ok") == "ok"
    assert br.state == CircuitState.CLOSED


def test_circuitbreaker_half_open_rejects_when_budget_exhausted(monkeypatch):
    """Test HALF_OPEN rejects calls after half_open_max_calls are used if not closed yet."""
    cfg = CircuitBreakerConfig(
        failure_threshold=1,
        success_threshold=3,  # higher than allowed calls
        timeout_seconds=0.01,
        half_open_max_calls=2,
        sliding_window_size=2,
        failure_rate_threshold=1.0,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # OPEN
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert br.state == CircuitState.OPEN

    # HALF_OPEN by advancing time
    opened_at = br._opened_at
    now = opened_at + cfg.timeout_seconds + 0.001
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: now)
    assert br.state == CircuitState.HALF_OPEN

    # Use the budget with two successes, still HALF_OPEN because threshold is 3
    assert br.execute(lambda: "ok") == "ok"
    assert br.execute(lambda: "ok") == "ok"
    assert br.state == CircuitState.HALF_OPEN

    # Third call should be rejected
    with pytest.raises(CircuitBreakerOpenError) as exc:
        br.execute(lambda: "ok")
    # Remaining time clamped to 0 when in HALF_OPEN/timeout exceeded
    assert exc.value.remaining_time == pytest.approx(0.0)
    assert br.metrics.rejected_calls == 1


def test_circuitbreaker_half_open_failure_transitions_to_open_immediately(monkeypatch):
    """Test any failure in HALF_OPEN transitions back to OPEN."""
    cfg = CircuitBreakerConfig(
        failure_threshold=1,
        success_threshold=2,
        timeout_seconds=0.01,
        half_open_max_calls=2,
        sliding_window_size=2,
        failure_rate_threshold=1.0,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # OPEN breaker first
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
    assert br.state == CircuitState.OPEN

    # HALF_OPEN by time
    now = br._opened_at + cfg.timeout_seconds + 0.001
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: now)
    assert br.state == CircuitState.HALF_OPEN

    # A failure should push it back to OPEN
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert br.state == CircuitState.OPEN


def test_circuitbreaker_execute_rejects_when_open_without_fallback():
    """Test execute raises CircuitBreakerOpenError when OPEN and no fallback provided."""
    cfg = CircuitBreakerConfig(
        failure_threshold=1,
        timeout_seconds=1.0,
        sliding_window_size=2,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # Force OPEN
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert br.state == CircuitState.OPEN

    # Immediate execute should be rejected with remaining_time ~ timeout_seconds
    with pytest.raises(CircuitBreakerOpenError) as exc:
        br.execute(lambda: "ok")
    assert exc.value.name == br.name
    assert exc.value.remaining_time == pytest.approx(cfg.timeout_seconds, rel=0.2)
    assert br.metrics.rejected_calls == 1


def test_circuitbreaker_execute_uses_fallback_when_open():
    """Test execute returns fallback value when OPEN."""
    cfg = CircuitBreakerConfig(failure_threshold=1, timeout_seconds=0.5)
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # OPEN
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert br.state == CircuitState.OPEN

    result = br.execute(lambda: "ok", fallback=lambda: "fallback")
    assert result == "fallback"
    assert br.metrics.rejected_calls == 1


def test_circuitbreaker_should_attempt_reset_logic(monkeypatch, breaker):
    """Test _should_attempt_reset returns correct booleans."""
    # Not opened
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False

    # Opened but not enough time passed
    base = 1000.0
    breaker._opened_at = base
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds - 0.001)
    assert breaker._should_attempt_reset() is False

    # Enough time passed
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + breaker.config.timeout_seconds + 0.001)
    assert breaker._should_attempt_reset() is True


def test_circuitbreaker_transition_resets_counters_on_closed(breaker):
    """Test _transition_to CLOSED resets counters and clears sliding window."""
    # Make some state changes and data
    breaker._failure_count = 5
    breaker._success_count = 3
    breaker._sliding_window.extend([True, False, True])
    breaker._opened_at = time.time()

    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0


def test_circuitbreaker_allow_request_logic(monkeypatch, breaker):
    """Test _allow_request behavior across states."""
    # CLOSED: should allow
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._allow_request() is True

    # OPEN: should reject while within timeout
    breaker._transition_to(CircuitState.OPEN)
    opened_at = breaker._opened_at
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: opened_at + 0.0)
    assert breaker._allow_request() is False

    # HALF_OPEN: allows up to half_open_max_calls
    breaker._transition_to(CircuitState.HALF_OPEN)
    for i in range(breaker.config.half_open_max_calls):
        assert breaker._allow_request() is True
    assert breaker._allow_request() is False


def test_circuitbreaker_calculate_failure_rate_requires_full_window():
    """Test _calculate_failure_rate returns 0 until window is full, then computes correctly."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # avoid opening
        failure_rate_threshold=1.0,
        sliding_window_size=4,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)

    # Add three entries: still returns 0.0
    br._record_failure(0.01)
    br._record_failure(0.01)
    br._record_success(0.01)
    assert br._calculate_failure_rate() == pytest.approx(0.0)

    # Add one more success to fill window: now 2 failures, 2 successes => 0.5
    br._record_success(0.01)
    assert br._calculate_failure_rate() == pytest.approx(0.5)


def test_circuitbreaker_record_success_decrements_failure_count_not_below_zero():
    """Test _record_success decrements failure count in CLOSED but not below zero."""
    cfg = CircuitBreakerConfig(
        failure_threshold=10,
        sliding_window_size=2,
    )
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}", config=cfg)
    br._failure_count = 1
    br._transition_to(CircuitState.CLOSED)
    br._record_success(0.01)
    assert br._failure_count == 0
    br._record_success(0.01)
    assert br._failure_count == 0


def test_circuitbreaker_get_health_info(breaker):
    """Test get_health_info returns expected structure and values."""
    # Perform some calls: 1 success, 1 failure
    assert breaker.execute(lambda: "ok") == "ok"
    with pytest.raises(RuntimeError):
        breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    health = breaker.get_health_info()

    assert health["name"] == breaker.name
    assert health["state"] in {s.value for s in CircuitState}
    assert isinstance(health["failure_count"], int)
    assert isinstance(health["success_count"], int)
    assert isinstance(health["metrics"], dict)
    assert "average_response_time_ms" in health["metrics"]
    assert health["metrics"]["average_response_time_ms"] == pytest.approx(breaker.metrics.average_response_time * 1000)
    assert health["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert health["config"]["success_threshold"] == breaker.config.success_threshold
    assert health["config"]["timeout_seconds"] == pytest.approx(breaker.config.timeout_seconds)


def test_circuit_breaker_decorator_executes_and_exposes_breaker(config_small):
    """Test circuit_breaker decorator wraps function and exposes breaker."""
    name = f"decorator-{uuid.uuid4()}"

    @circuit_breaker(name, config_small)
    def foo(x):
        return x * 2

    result = foo(3)
    assert result == 6
    assert hasattr(foo, "circuit_breaker")
    br = foo.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    assert br.metrics.total_calls == 1


def test_coordinator_register_breaker_sends_registration(monkeypatch):
    """Test coordinator register_breaker triggers registration HTTP call."""
    calls = []

    def fake_urlopen(req, timeout=5):
        calls.append(req)
        return SimpleNamespace(read=lambda: b"ok")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord")
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}")
    coord.register_breaker(br)

    assert len(calls) == 1
    req = calls[0]
    assert "/circuit-breakers/register" in req.full_url
    assert req.get_method() == "POST"
    data = json.loads(req.data.decode("utf-8"))
    assert data["service"] == br.name
    assert "failure_threshold" in data
    assert "success_threshold" in data


def test_coordinator_send_registration_ignores_url_error(monkeypatch):
    """Test _send_registration ignores URLError exceptions."""
    def fake_urlopen(req, timeout=5):
        raise urllib.error.URLError("network")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord")
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}")

    # Should not raise
    coord._send_registration(br)


def test_coordinator_synchronize_states_posts_state(monkeypatch):
    """Test _synchronize_states posts breaker state payload to coordinator."""
    posted = []

    def fake_urlopen(req, timeout=5):
        posted.append(req)
        return SimpleNamespace(read=lambda: b"{}")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)

    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord")
    br = CircuitBreaker(name=f"svc-{uuid.uuid4()}")
    coord.register_breaker(br)

    coord._synchronize_states()
    assert len(posted) == 2  # one for register, one for state
    req = posted[-1]
    assert "/circuit-breakers/state" in req.full_url
    assert req.get_method() == "POST"
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == br.name
    assert payload["state"] == br.state.value
    assert "health_info" in payload


def test_coordinator_get_cluster_state_success(monkeypatch):
    """Test get_cluster_state returns parsed JSON on success."""
    expected = {"name": "svc", "state": "CLOSED"}

    def fake_urlopen(req, timeout=5):
        assert req.get_method() == "GET"
        return SimpleNamespace(read=lambda: json.dumps(expected).encode("utf-8"))

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord")

    result = coord.get_cluster_state("svc")
    assert result == expected


def test_coordinator_get_cluster_state_failure(monkeypatch):
    """Test get_cluster_state returns error dict on URLError."""
    def fake_urlopen(req, timeout=5):
        raise urllib.error.URLError("down")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord")

    result = coord.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}


def test_coordinator_start_and_stop_sync(monkeypatch):
    """Test start_sync spawns background thread and stop_sync terminates it."""
    coord = DistributedCircuitBreakerCoordinator(coordinator_url="http://coord", sync_interval=0.01)

    def side_effect():
        # Stop after first call to exit the loop
        coord._running = False

    mock_sync = Mock(side_effect=side_effect)
    monkeypatch.setattr(coord, "_synchronize_states", mock_sync)
    monkeypatch.setattr("src.circuit_breaker.time.sleep", lambda _: None)

    coord.start_sync()
    # Wait for thread to exit
    coord.stop_sync()

    assert mock_sync.called
    assert coord._sync_thread is not None
    assert not coord._sync_thread.is_alive()