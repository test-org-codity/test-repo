import json
import threading
import time
from unittest.mock import Mock, patch

import pytest

import src.circuit_breaker as cb_mod
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
def reset_circuit_breaker_registry():
    """Ensure CircuitBreaker registry is clean before and after each test."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


def test_circuit_state_members():
    """Ensure CircuitState has expected members."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_metrics_record_response_time_updates_average():
    """Test that CircuitBreakerMetrics correctly updates average response time."""
    metrics = CircuitBreakerMetrics()
    durations = [0.1, 0.2, 0.3]
    for d in durations:
        metrics.record_response_time(d)

    expected_avg = sum(durations) / len(durations)
    assert metrics.average_response_time == pytest.approx(expected_avg)
    assert len(metrics._response_times) == 3


def test_circuit_breaker_get_or_create_same_instance():
    """get_or_create should return the same instance for the same name."""
    cb1 = CircuitBreaker.get_or_create("service-a")
    cb2 = CircuitBreaker.get_or_create("service-a")
    cb3 = CircuitBreaker.get_or_create("service-b")
    assert cb1 is cb2
    assert cb1 is not cb3


def test_circuit_breaker_state_transitions_open_to_half_open_after_timeout(monkeypatch):
    """State should transition from OPEN to HALF_OPEN after timeout seconds elapse when accessed."""
    # Prepare fake time
    class FakeTime:
        def __init__(self, start):
            self.current = start

        def time(self):
            return self.current

    ft = FakeTime(1000.0)
    monkeypatch.setattr(cb_mod.time, "time", ft.time)

    config = CircuitBreakerConfig(timeout_seconds=30.0)
    cb = CircuitBreaker("svc", config)

    # Transition to OPEN and verify
    cb._transition_to(CircuitState.OPEN)
    assert cb.state == CircuitState.OPEN
    opened_transitions = cb.metrics.state_transitions

    # Not enough time passed
    assert cb.state == CircuitState.OPEN
    assert cb.metrics.state_transitions == opened_transitions

    # Advance time beyond timeout and access state to trigger HALF_OPEN
    ft.current = 1031.0
    assert cb.state == CircuitState.HALF_OPEN
    assert cb.metrics.state_transitions == opened_transitions + 1
    assert cb._half_open_calls == 0
    assert cb._success_count == 0


def test_circuit_breaker_transition_to_closed_resets_counters():
    """Transition to CLOSED should reset counts and clear sliding window."""
    cb = CircuitBreaker("svc")
    # simulate some activity
    cb._failure_count = 5
    cb._success_count = 2
    cb._sliding_window.extend([True, False, True])
    cb._opened_at = 123.0

    cb._transition_to(CircuitState.CLOSED)

    assert cb.state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0


def test_circuit_breaker_execute_success_updates_metrics():
    """Executing a successful operation updates metrics and sliding window."""
    cb = CircuitBreaker("svc")
    result = cb.execute(lambda: "ok")
    assert result == "ok"
    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.failed_calls == 0
    assert len(cb._sliding_window) == 1
    assert cb._sliding_window[-1] is True


def test_circuit_breaker_execute_failure_opens_on_threshold():
    """A single failure can open the circuit when failure_threshold is 1."""
    config = CircuitBreakerConfig(failure_threshold=1, sliding_window_size=10, failure_rate_threshold=0.5)
    cb = CircuitBreaker("svc", config)

    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("boom")))

    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.state == CircuitState.OPEN
    assert cb._opened_at is not None


def test_circuit_breaker_execute_open_rejects_without_fallback_raises(monkeypatch):
    """When OPEN and no fallback provided, execute should raise CircuitBreakerOpenError with remaining time."""
    cb = CircuitBreaker("svc", CircuitBreakerConfig(timeout_seconds=10.0))
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    # Fix time to ensure not enough time has passed
    def fixed_time():
        return opened_at + 2.0

    monkeypatch.setattr(cb_mod.time, "time", fixed_time)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(lambda: "won't run")

    assert cb.metrics.rejected_calls == 1
    # Remaining time should be approximately timeout - elapsed (10 - 2)
    assert exc.value.remaining_time == pytest.approx(8.0, rel=1e-3, abs=1e-3)


def test_circuit_breaker_execute_open_with_fallback_returns_value(monkeypatch):
    """When OPEN and fallback provided, execute should return fallback value and not run operation."""
    cb = CircuitBreaker("svc", CircuitBreakerConfig(timeout_seconds=10.0))
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fixed_time():
        return opened_at + 1.0

    monkeypatch.setattr(cb_mod.time, "time", fixed_time)

    op = Mock(side_effect=AssertionError("operation should not be called"))
    fb = Mock(return_value="fallback")

    result = cb.execute(op, fallback=fb)
    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    fb.assert_called_once()
    op.assert_not_called()


def test_circuit_breaker_half_open_allows_up_to_max_calls_then_rejects_with_fallback(monkeypatch):
    """In HALF_OPEN, only up to half_open_max_calls are allowed; further calls are rejected."""
    config = CircuitBreakerConfig(timeout_seconds=5.0, half_open_max_calls=2, success_threshold=5)
    cb = CircuitBreaker("svc", config)

    # Open and then transition to HALF_OPEN by time
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        # Return value greater than (opened_at + timeout) to ensure HALF_OPEN
        return opened_at + config.timeout_seconds + 0.1

    monkeypatch.setattr(cb_mod.time, "time", fake_time)
    assert cb.state == CircuitState.HALF_OPEN

    # Two successful calls allowed
    assert cb.execute(lambda: "ok1") == "ok1"
    assert cb.execute(lambda: "ok2") == "ok2"

    # Third call should be rejected; ensure fallback path works
    fb = Mock(return_value="fb")
    res = cb.execute(lambda: "never", fallback=fb)
    assert res == "fb"
    assert fb.called


def test_circuit_breaker_half_open_successes_close_breaker(monkeypatch):
    """In HALF_OPEN, reaching success_threshold transitions breaker to CLOSED."""
    config = CircuitBreakerConfig(timeout_seconds=1.0, half_open_max_calls=5, success_threshold=2)
    cb = CircuitBreaker("svc", config)

    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + config.timeout_seconds + 0.1

    monkeypatch.setattr(cb_mod.time, "time", fake_time)

    # First success in HALF_OPEN
    assert cb.state == CircuitState.HALF_OPEN
    cb.execute(lambda: "ok")

    # Second success should close the circuit
    cb.execute(lambda: "ok2")
    assert cb.state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0


def test_circuit_breaker_half_open_failure_reopens(monkeypatch):
    """Any failure in HALF_OPEN transitions breaker back to OPEN."""
    config = CircuitBreakerConfig(timeout_seconds=1.0, half_open_max_calls=3, success_threshold=2)
    cb = CircuitBreaker("svc", config)

    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + config.timeout_seconds + 0.1

    monkeypatch.setattr(cb_mod.time, "time", fake_time)

    assert cb.state == CircuitState.HALF_OPEN
    with pytest.raises(ValueError):
        cb.execute(lambda: (_ for _ in ()).throw(ValueError("fail")))
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_full_window_only():
    """Failure rate should be 0 until sliding window is full, then reflect actual rate."""
    config = CircuitBreakerConfig(sliding_window_size=4, failure_threshold=1000, failure_rate_threshold=0.99)
    cb = CircuitBreaker("svc", config)

    cb._record_failure(0.01)
    cb._record_success(0.01)
    cb._record_failure(0.01)

    # Not full window yet
    assert cb._calculate_failure_rate() == pytest.approx(0.0)

    cb._record_success(0.01)
    # Now full: 2 failures out of 4 -> 0.5
    assert cb._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_contains_expected_fields():
    """get_health_info should include state, metrics, and config details."""
    cb = CircuitBreaker("svc")
    cb.execute(lambda: "ok")
    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))

    info = cb.get_health_info()
    assert info["name"] == "svc"
    assert info["state"] in {CircuitState.CLOSED.value, CircuitState.OPEN.value, CircuitState.HALF_OPEN.value}
    assert "metrics" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 1
    # average_response_time_ms equals average_response_time * 1000
    expected_ms = cb.metrics.average_response_time * 1000
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(expected_ms)
    assert "config" in info
    assert info["config"]["failure_threshold"] == cb.config.failure_threshold
    assert info["config"]["success_threshold"] == cb.config.success_threshold
    assert info["config"]["timeout_seconds"] == cb.config.timeout_seconds


def test_coordinator_register_breaker_sends_registration_request():
    """register_breaker should POST registration to coordinator."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        cb = CircuitBreaker("svc")
        coord.register_breaker(cb)

        assert "svc" in coord._breakers
        assert mock_urlopen.call_count == 1

        # Inspect the request
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.get_full_url().endswith("/circuit-breakers/register")
        assert kwargs.get("timeout") == 5
        sent = json.loads(req.data.decode("utf-8"))
        assert sent["service"] == "svc"
        assert sent["failure_threshold"] == cb.config.failure_threshold
        assert sent["success_threshold"] == cb.config.success_threshold


def test_coordinator_register_breaker_handles_urlerror():
    """register_breaker should ignore URLError and not raise."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=cb_mod.urllib.error.URLError("fail")):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        cb = CircuitBreaker("svc")
        coord.register_breaker(cb)
        # No exception should be raised and breaker should be registered
        assert "svc" in coord._breakers


def test_coordinator_synchronize_states_posts_state_for_each_breaker():
    """_synchronize_states should POST state for each registered breaker."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        cb1 = CircuitBreaker("svc1")
        cb2 = CircuitBreaker("svc2")
        coord.register_breaker(cb1)
        coord.register_breaker(cb2)

        coord._synchronize_states()

        assert mock_urlopen.call_count == 2
        urls = []
        payloads = []
        for call in mock_urlopen.call_args_list:
            req = call[0][0]
            urls.append(req.get_full_url())
            payloads.append(json.loads(req.data.decode("utf-8")))
        assert all(u.endswith("/circuit-breakers/state") for u in urls)
        services = {p["service"] for p in payloads}
        assert {"svc1", "svc2"} == services
        for p in payloads:
            assert p["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
            assert "health_info" in p


def test_coordinator_start_and_stop_sync_invokes_synchronize(monkeypatch):
    """start_sync should run background thread that invokes _synchronize_states; stop_sync should stop it."""
    coord = DistributedCircuitBreakerCoordinator("http://coord", sync_interval=0.01)
    called = threading.Event()

    def fake_sync():
        called.set()

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)
    # Patch sleep to minimal to accelerate loop
    monkeypatch.setattr(cb_mod.time, "sleep", lambda s: None)

    coord.start_sync()
    # Wait briefly for the thread to run
    start = time.time()
    while not called.is_set() and (time.time() - start) < 1.0:
        pass
    coord.stop_sync()

    assert called.is_set()
    assert coord._running is False


def test_coordinator_get_cluster_state_success():
    """get_cluster_state should return parsed JSON on success."""
    response_payload = {"cluster": "ok", "nodes": 3}

    class DummyResponse:
        def read(self):
            return json.dumps(response_payload).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=DummyResponse()) as mock_urlopen:
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        state = coord.get_cluster_state("svc")
        assert state == response_payload
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.get_full_url().endswith("/circuit-breakers/svc/aggregate")
        assert kwargs.get("timeout") == 5


def test_coordinator_get_cluster_state_failure_returns_error():
    """get_cluster_state should return error dict when request fails."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=cb_mod.urllib.error.URLError("boom")):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        state = coord.get_cluster_state("svc")
        assert state == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_and_calls_execute():
    """circuit_breaker decorator should wrap function and use underlying CircuitBreaker to execute."""
    # Ensure registry clean
    CircuitBreaker._registry.clear()

    @circuit_breaker("decor-svc")
    def my_func(x, y):
        return x + y

    assert hasattr(my_func, "circuit_breaker")
    br = my_func.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    before_calls = br.metrics.total_calls
    result = my_func(2, 3)
    assert result == 5
    assert br.metrics.total_calls == before_calls + 1
    assert getattr(my_func, "__wrapped__") is not None


def test_circuit_breaker_open_error_remaining_time_value(monkeypatch):
    """CircuitBreakerOpenError remaining_time should reflect time left before HALF_OPEN attempt."""
    config = CircuitBreakerConfig(timeout_seconds=20.0)
    cb = CircuitBreaker("svc", config)
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    # Advance time by 7 seconds (< timeout)
    def fake_time():
        return opened_at + 7.0

    monkeypatch.setattr(cb_mod.time, "time", fake_time)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(lambda: "x")

    assert exc.value.remaining_time == pytest.approx(13.0, rel=1e-3, abs=1e-3)