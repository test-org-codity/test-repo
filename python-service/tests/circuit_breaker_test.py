import json
import time
import threading
import pytest
from unittest.mock import Mock, patch
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
def clean_registry(monkeypatch):
    """Ensure CircuitBreaker registry is clean for each test."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


@pytest.fixture
def cb_config():
    """Provide a default CircuitBreakerConfig for testing."""
    return CircuitBreakerConfig()


@pytest.fixture
def cb_instance(cb_config):
    """Create a CircuitBreaker instance with a unique name."""
    return CircuitBreaker(name="test_breaker", config=cb_config)


def test_circuit_state_values_present():
    """Test that CircuitState enum contains expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test that CircuitBreakerConfig has correct default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test that record_response_time updates average response time correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_open_error_attributes_and_message():
    """Test CircuitBreakerOpenError contains name and remaining_time with correct message."""
    err = CircuitBreakerOpenError(name="svc", remaining_time=12.3456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)


def test_circuit_breaker_get_or_create_returns_singleton(cb_config):
    """Test get_or_create returns the same instance for the same name."""
    b1 = CircuitBreaker.get_or_create("svc1", cb_config)
    b2 = CircuitBreaker.get_or_create("svc1", cb_config)
    assert b1 is b2
    b3 = CircuitBreaker.get_or_create("svc2", cb_config)
    assert b3 is not b1


def test_circuit_breaker_should_attempt_reset_false_when_opened_at_none(cb_instance):
    """Test _should_attempt_reset is False when _opened_at is None."""
    cb = cb_instance
    cb._opened_at = None
    assert cb._should_attempt_reset() is False


def test_circuit_breaker_state_transitions_to_half_open_after_timeout():
    """Test state property transitions OPEN -> HALF_OPEN when timeout has elapsed."""
    cfg = CircuitBreakerConfig(timeout_seconds=0.1)
    cb = CircuitBreaker("timeout_breaker", cfg)
    cb._transition_to(CircuitState.OPEN)
    # Ensure some time passes to exceed timeout
    time.sleep(0.2)
    assert cb.state == CircuitState.HALF_OPEN
    assert cb.metrics.state_transitions >= 2  # one to OPEN, one to HALF_OPEN
    assert cb._half_open_calls == 0
    assert cb._success_count == 0


def test_circuit_breaker_transition_to_open_sets_opened_at(monkeypatch, cb_instance):
    """Test that transitioning to OPEN sets _opened_at to current time."""
    cb = cb_instance
    fake_time = 12345.678
    with patch("src.circuit_breaker.time.time", return_value=fake_time):
        cb._transition_to(CircuitState.OPEN)
    assert cb._opened_at == pytest.approx(fake_time)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_transition_to_closed_resets_counters_and_clears_window(cb_instance):
    """Test transitioning to CLOSED resets counts and clears sliding window."""
    cb = cb_instance
    cb._failure_count = 3
    cb._success_count = 2
    cb._sliding_window.extend([True, False, True])
    cb._opened_at = 1.0
    cb._transition_to(CircuitState.CLOSED)
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_allow_request_behaviour_in_states():
    """Test _allow_request returns expected values for each state."""
    cfg = CircuitBreakerConfig(half_open_max_calls=2, timeout_seconds=10)
    cb = CircuitBreaker("allow_request_breaker", cfg)

    # CLOSED allows
    cb._transition_to(CircuitState.CLOSED)
    assert cb._allow_request() is True

    # OPEN rejects
    cb._transition_to(CircuitState.OPEN)
    # Ensure timeout not elapsed
    cb._opened_at = time.time()
    assert cb._allow_request() is False

    # HALF_OPEN allows up to half_open_max_calls
    cb._transition_to(CircuitState.HALF_OPEN)
    assert cb._allow_request() is True
    assert cb._allow_request() is True
    assert cb._allow_request() is False


def test_circuit_breaker_execute_success_updates_metrics_and_window():
    """Test execute success path updates metrics and sliding window."""
    cb = CircuitBreaker("exec_success", CircuitBreakerConfig())
    result = cb.execute(lambda: "ok")
    assert result == "ok"
    result2 = cb.execute(lambda: "ok2")
    assert result2 == "ok2"
    assert cb.metrics.total_calls == 2
    assert cb.metrics.successful_calls == 2
    assert cb.metrics.failed_calls == 0
    assert len(cb._sliding_window) == 2
    assert all(cb._sliding_window)


def test_circuit_breaker_execute_failure_opens_on_threshold_count():
    """Test that consecutive failures open the breaker when reaching failure_threshold."""
    cfg = CircuitBreakerConfig(failure_threshold=2, failure_rate_threshold=1.0)
    cb = CircuitBreaker("exec_failure_count", cfg)

    with pytest.raises(ValueError):
        cb.execute(lambda: (_ for _ in ()).throw(ValueError("boom1")))
    assert cb.state == CircuitState.CLOSED
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.total_calls == 1

    with pytest.raises(ValueError):
        cb.execute(lambda: (_ for _ in ()).throw(ValueError("boom2")))
    assert cb.state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 2
    assert cb.metrics.total_calls == 2
    assert cb._opened_at is not None
    assert cb.metrics.state_transitions >= 1


def test_circuit_breaker_execute_failure_opens_on_failure_rate():
    """Test that failure rate threshold opens the breaker based on sliding window."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100, sliding_window_size=4, failure_rate_threshold=0.5
    )
    cb = CircuitBreaker("exec_failure_rate", cfg)

    # Pattern: F, F, S, F -> failures = 3/4 = 0.75 >= 0.5; open on last failure
    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("f1")))
    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("f2")))
    assert cb.state == CircuitState.CLOSED  # still closed before window full

    cb.execute(lambda: "ok")  # success
    assert cb.state == CircuitState.CLOSED

    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("f3")))

    assert cb.state == CircuitState.OPEN
    assert len(cb._sliding_window) == 4
    failures = sum(1 for s in cb._sliding_window if not s)
    assert failures == 3


def test_circuit_breaker_half_open_successes_transition_to_closed():
    """Test that enough successes in HALF_OPEN transition the breaker to CLOSED."""
    cfg = CircuitBreakerConfig(success_threshold=2, half_open_max_calls=5)
    cb = CircuitBreaker("half_open_success", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    assert cb.state == CircuitState.HALF_OPEN
    cb.execute(lambda: "ok1")
    assert cb.state == CircuitState.HALF_OPEN
    cb.execute(lambda: "ok2")  # should close after reaching success_threshold
    assert cb.state == CircuitState.CLOSED
    assert cb._success_count == 0  # reset on CLOSED


def test_circuit_breaker_half_open_failure_transitions_to_open():
    """Test that a failure in HALF_OPEN transitions breaker back to OPEN."""
    cfg = CircuitBreakerConfig(success_threshold=2, half_open_max_calls=3)
    cb = CircuitBreaker("half_open_failure", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    with pytest.raises(RuntimeError):
        cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
    assert cb.state == CircuitState.OPEN
    assert cb._opened_at is not None


def test_circuit_breaker_rejection_in_open_with_fallback_and_error():
    """Test that OPEN state rejects calls, uses fallback if provided, otherwise raises error."""
    cfg = CircuitBreakerConfig(timeout_seconds=1.0)
    cb = CircuitBreaker("open_rejection", cfg)
    cb._transition_to(CircuitState.OPEN)
    cb._opened_at = time.time()

    # With fallback
    result = cb.execute(lambda: "won't run", fallback=lambda: "fallback")
    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    assert cb.metrics.total_calls == 0  # rejected does not count as total call

    # Without fallback, should raise CircuitBreakerOpenError
    with pytest.raises(CircuitBreakerOpenError) as excinfo:
        cb.execute(lambda: "still won't run")
    err = excinfo.value
    assert err.name == "open_rejection"
    # Remaining time approximately equal to timeout, depending on small elapsed time
    assert err.remaining_time == pytest.approx(cfg.timeout_seconds, rel=0.1, abs=0.2)


def test_circuit_breaker_calculate_failure_rate_requires_full_window():
    """Test that _calculate_failure_rate returns 0.0 until window is full."""
    cfg = CircuitBreakerConfig(sliding_window_size=3, failure_threshold=1000, failure_rate_threshold=1.0)
    cb = CircuitBreaker("rate_window", cfg)

    # Less than window size -> rate is 0.0
    cb._record_failure(0.01)
    assert cb._calculate_failure_rate() == pytest.approx(0.0)
    cb._record_success(0.01)
    assert cb._calculate_failure_rate() == pytest.approx(0.0)

    # Now fill to window size
    cb._record_failure(0.01)
    # Now len == size; failures = 2/3
    assert cb._calculate_failure_rate() == pytest.approx(2 / 3)


def test_circuit_breaker_get_health_info_structure_and_values():
    """Test get_health_info returns correct structure and values including failure rate and average latency."""
    cfg = CircuitBreakerConfig(sliding_window_size=4, failure_threshold=1000, failure_rate_threshold=1.0)
    cb = CircuitBreaker("health_info", cfg)

    # Record times and outcomes: S(0.1), S(0.3), F(0.2), F(0.4)
    cb._record_success(0.1)
    cb._record_success(0.3)
    cb._record_failure(0.2)
    cb._record_failure(0.4)

    info = cb.get_health_info()
    assert info["name"] == "health_info"
    assert info["state"] == cb.state.value
    assert info["failure_count"] >= 0
    assert info["success_count"] >= 0
    assert info["failure_rate"] == pytest.approx(0.5)
    assert info["metrics"]["successful_calls"] == 2
    assert info["metrics"]["failed_calls"] == 2
    assert info["metrics"]["total_calls"] == 0  # We didn't use execute() for these updates
    # Average response time: (0.1+0.3+0.2+0.4)/4 = 0.25s => 250ms
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(250.0)
    assert info["config"]["failure_threshold"] == 1000
    assert info["config"]["success_threshold"] == cfg.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(cfg.timeout_seconds)


def test_coordinator_register_breaker_sends_registration():
    """Test that register_breaker sends registration payload via HTTP POST."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    cb = CircuitBreaker("service_to_register")
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator.register_breaker(cb)
        assert "service_to_register" in coordinator._breakers
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"


def test_coordinator_synchronize_states_posts_per_breaker():
    """Test that _synchronize_states posts each registered breaker state."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")
    cb1 = CircuitBreaker("svc1")
    cb2 = CircuitBreaker("svc2")
    coordinator.register_breaker(cb1)
    coordinator.register_breaker(cb2)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator._synchronize_states()
        # Two state posts expected
        # There may also be registration posts earlier; we assert at least two posts happened here
        # But to isolate, reset mock calls before synchronize call
    # Repeat with isolated mock to strictly assert 2 calls
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen2:
        mock_urlopen2.return_value = Mock()
        coordinator._synchronize_states()
        assert mock_urlopen2.call_count == 2
        for call in mock_urlopen2.call_args_list:
            req = call[0][0]
            assert req.full_url.endswith("/circuit-breakers/state")
            assert req.get_method() == "POST"


def test_coordinator_get_cluster_state_success_and_error():
    """Test get_cluster_state returns parsed JSON on success and error dict on URLError."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator")

    class FakeResponse:
        def read(self):
            return json.dumps({"state": "OPEN", "nodes": 3}).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=FakeResponse()) as mock_urlopen:
        result = coordinator.get_cluster_state("test")
        assert result["state"] == "OPEN"
        assert result["nodes"] == 3
        req = mock_urlopen.call_args[0][0]
        assert req.get_method() == "GET"
        assert req.full_url.endswith("/circuit-breakers/test/aggregate")

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("network")):
        result_err = coordinator.get_cluster_state("test")
        assert result_err["error"] == "Failed to fetch cluster state"


def test_coordinator_start_stop_sync_invokes_periodic_sync(monkeypatch):
    """Test that start_sync starts background thread and stop_sync stops it, invoking _synchronize_states periodically."""
    coordinator = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)

    sync_mock = Mock()
    monkeypatch.setattr(coordinator, "_synchronize_states", sync_mock)

    coordinator.start_sync()
    time.sleep(0.05)
    coordinator.stop_sync()

    assert sync_mock.call_count >= 1
    assert coordinator._running is False
    assert isinstance(coordinator._sync_thread, threading.Thread)


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test the circuit_breaker decorator wraps the function and uses the underlying breaker."""
    decorated_name = "decorated_service"
    calls = {"count": 0}

    @circuit_breaker(decorated_name)
    def hello(name):
        calls["count"] += 1
        return f"hello {name}"

    assert hasattr(hello, "__wrapped__")
    assert hasattr(hello, "circuit_breaker")
    assert hello.circuit_breaker.name == decorated_name

    res = hello("world")
    assert res == "hello world"
    assert calls["count"] == 1
    # Metrics should be updated
    br = hello.circuit_breaker
    assert br.metrics.total_calls == 1
    assert br.metrics.successful_calls == 1