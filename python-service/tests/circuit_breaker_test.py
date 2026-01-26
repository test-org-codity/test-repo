import json
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from src.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerMetrics,
    CircuitBreakerOpenError,
    CircuitState,
    DistributedCircuitBreakerCoordinator,
)


@pytest.fixture(autouse=True)
def reset_circuit_breaker_registry():
    """Reset CircuitBreaker global registry to prevent cross-test interference."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Create a default CircuitBreakerConfig for tests."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Create a CircuitBreaker instance for tests."""
    return CircuitBreaker(name="svc", config=default_config)


@pytest.fixture
def fast_timeout_config():
    """Config with short timeout and low thresholds for state transition tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_fast(fast_timeout_config):
    """Create a CircuitBreaker instance with low thresholds for tests."""
    return CircuitBreaker(name="svc_fast", config=fast_timeout_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator instance."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator", sync_interval=0.01)


def test_circuit_state_values():
    """Test CircuitState enum values are as defined."""
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


def test_circuit_breaker_metrics_record_response_time_average():
    """Test CircuitBreakerMetrics.record_response_time updates average_response_time."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    assert m.average_response_time == pytest.approx(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_open_error_message_and_fields():
    """Test CircuitBreakerOpenError keeps name/remaining_time and formats message."""
    err = CircuitBreakerOpenError("svc", 1.2345)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.2345)
    assert "Circuit breaker 'svc' is open." in str(err)
    assert "Retry after 1.23s" in str(err)


def test_circuit_breaker_init_defaults(default_config):
    """Test CircuitBreaker initialization sets expected default internal state and metrics."""
    b = CircuitBreaker("svc", default_config)
    assert b.name == "svc"
    assert b.config is default_config
    assert b.state == CircuitState.CLOSED
    assert b._failure_count == 0
    assert b._success_count == 0
    assert b._half_open_calls == 0
    assert b._opened_at is None
    assert len(b._sliding_window) == 0
    assert b.metrics.total_calls == 0
    assert b.metrics.successful_calls == 0
    assert b.metrics.failed_calls == 0
    assert b.metrics.rejected_calls == 0
    assert b.metrics.state_transitions == 0
    assert b.metrics.average_response_time == pytest.approx(0.0)


def test_circuit_breaker_get_or_create_returns_same_instance(default_config):
    """Test CircuitBreaker.get_or_create returns a cached instance for the same name."""
    a = CircuitBreaker.get_or_create("svc", default_config)
    b = CircuitBreaker.get_or_create("svc", CircuitBreakerConfig(failure_threshold=99))
    assert a is b
    assert a.config is default_config


def test_circuit_breaker_state_open_transitions_to_half_open_after_timeout(breaker_fast):
    """Test state property triggers OPEN -> HALF_OPEN transition after timeout."""
    with patch("src.circuit_breaker.time.time", return_value=100.0):
        breaker_fast._transition_to(CircuitState.OPEN)
        assert breaker_fast._opened_at == pytest.approx(100.0)
        assert breaker_fast._state == CircuitState.OPEN

    with patch("src.circuit_breaker.time.time", return_value=109.0):
        assert breaker_fast.state == CircuitState.OPEN

    with patch("src.circuit_breaker.time.time", return_value=111.0):
        assert breaker_fast.state == CircuitState.HALF_OPEN
        assert breaker_fast._state == CircuitState.HALF_OPEN
        assert breaker_fast._half_open_calls == 0
        assert breaker_fast._success_count == 0


def test_circuit_breaker_should_attempt_reset_false_when_opened_at_none(breaker):
    """Test _should_attempt_reset returns False if _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_when_timeout_passed(breaker_fast):
    """Test _should_attempt_reset returns True when timeout has elapsed."""
    breaker_fast._opened_at = 10.0
    with patch("src.circuit_breaker.time.time", return_value=25.0):
        assert breaker_fast._should_attempt_reset() is True


def test_circuit_breaker_transition_to_open_sets_opened_at_and_metrics(breaker):
    """Test _transition_to(OPEN) sets opened_at and increments state transitions."""
    with patch("src.circuit_breaker.time.time", return_value=123.0):
        breaker._transition_to(CircuitState.OPEN)
        assert breaker._state == CircuitState.OPEN
        assert breaker._opened_at == pytest.approx(123.0)
        assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_half_open_calls_and_success_count(breaker):
    """Test _transition_to(HALF_OPEN) resets half-open counters."""
    breaker._half_open_calls = 2
    breaker._success_count = 5
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_closed_resets_counts_and_clears_window(breaker):
    """Test _transition_to(CLOSED) resets counters, clears sliding window and opened_at."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._opened_at = 10.0
    breaker._sliding_window.append(False)
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_allow_request_closed_allows(breaker):
    """Test _allow_request returns True in CLOSED state."""
    breaker._state = CircuitState.CLOSED
    assert breaker._allow_request() is True


def test_circuit_breaker_allow_request_open_rejects(breaker):
    """Test _allow_request returns False in OPEN state."""
    breaker._state = CircuitState.OPEN
    assert breaker._allow_request() is False


def test_circuit_breaker_allow_request_half_open_limited_by_max_calls(breaker_fast):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls then rejects."""
    breaker_fast._state = CircuitState.HALF_OPEN
    assert breaker_fast._allow_request() is True
    assert breaker_fast._half_open_calls == 1
    assert breaker_fast._allow_request() is True
    assert breaker_fast._half_open_calls == 2
    assert breaker_fast._allow_request() is False
    assert breaker_fast._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_decrements_failure_count(breaker):
    """Test execute success records metrics, response time, and decrements failure count in CLOSED."""
    breaker._failure_count = 2

    t = iter([100.0, 100.25, 101.0])  # start, end, last_success_time
    with patch("src.circuit_breaker.time.time", side_effect=lambda: next(t)):

        def op():
            return "ok"

        result = breaker.execute(op)
        assert result == "ok"

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.rejected_calls == 0
    assert breaker.metrics.last_success_time == pytest.approx(101.0)
    assert breaker.metrics.average_response_time == pytest.approx(0.25)
    assert breaker._failure_count == 1
    assert list(breaker._sliding_window) == [True]


def test_circuit_breaker_execute_failure_records_metrics_and_raises(breaker):
    """Test execute failure records metrics, response time, and re-raises exception."""
    t = iter([10.0, 10.5, 11.0])  # start, end, last_failure_time
    with patch("src.circuit_breaker.time.time", side_effect=lambda: next(t)):

        def op():
            raise ValueError("boom")

        with pytest.raises(ValueError, match="boom"):
            breaker.execute(op)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.last_failure_time == pytest.approx(11.0)
    assert breaker.metrics.average_response_time == pytest.approx(0.5)
    assert list(breaker._sliding_window) == [False]


def test_circuit_breaker_execute_open_rejects_and_raises_open_error_with_remaining_time(breaker_fast):
    """Test execute rejects in OPEN state, increments rejected_calls, and raises CircuitBreakerOpenError."""
    breaker_fast._state = CircuitState.OPEN
    breaker_fast._opened_at = 100.0
    breaker_fast.config.timeout_seconds = 10.0

    with patch("src.circuit_breaker.time.time", return_value=105.0):
        with pytest.raises(CircuitBreakerOpenError) as ei:
            breaker_fast.execute(lambda: "nope")
    err = ei.value
    assert err.name == breaker_fast.name
    assert err.remaining_time == pytest.approx(5.0)
    assert breaker_fast.metrics.rejected_calls == 1
    assert breaker_fast.metrics.total_calls == 0


def test_circuit_breaker_execute_open_rejects_and_uses_fallback(breaker_fast):
    """Test execute uses fallback when OPEN and request is rejected."""
    breaker_fast._state = CircuitState.OPEN
    breaker_fast._opened_at = 100.0

    with patch("src.circuit_breaker.time.time", return_value=101.0):
        result = breaker_fast.execute(lambda: "primary", fallback=lambda: "fallback")
    assert result == "fallback"
    assert breaker_fast.metrics.rejected_calls == 1
    assert breaker_fast.metrics.total_calls == 0


def test_circuit_breaker_record_failure_opens_when_failure_threshold_reached(breaker_fast):
    """Test _record_failure transitions CLOSED -> OPEN when failure_count >= failure_threshold."""
    breaker_fast._state = CircuitState.CLOSED
    with patch("src.circuit_breaker.time.time", return_value=200.0):
        breaker_fast._record_failure(0.01)
        assert breaker_fast._state == CircuitState.CLOSED
        breaker_fast._record_failure(0.01)
        assert breaker_fast._state == CircuitState.OPEN
        assert breaker_fast._opened_at == pytest.approx(200.0)
    assert breaker_fast.metrics.failed_calls == 2
    assert breaker_fast.metrics.state_transitions == 1


def test_circuit_breaker_calculate_failure_rate_returns_zero_until_window_full(breaker_fast):
    """Test _calculate_failure_rate returns 0 until sliding_window_size is reached."""
    breaker_fast._sliding_window.clear()
    breaker_fast._sliding_window.extend([False, False, True])  # size 3 of 4
    assert breaker_fast._calculate_failure_rate() == pytest.approx(0.0)
    breaker_fast._sliding_window.append(False)  # size 4
    assert breaker_fast._calculate_failure_rate() == pytest.approx(3 / 4)


def test_circuit_breaker_record_failure_opens_when_failure_rate_threshold_reached(breaker_fast):
    """Test _record_failure transitions CLOSED -> OPEN when failure_rate >= threshold (with full window)."""
    breaker_fast.config.failure_threshold = 999  # ensure rate triggers, not count
    breaker_fast._state = CircuitState.CLOSED

    # Pre-fill window to just below threshold once full: 1 failure / 4 = 0.25
    breaker_fast._sliding_window.clear()
    breaker_fast._sliding_window.extend([True, True, True])  # len 3 (< 4) => rate calc is 0.0

    with patch("src.circuit_breaker.time.time", return_value=300.0):
        breaker_fast._record_failure(0.01)  # window now full with 1 failure => 0.25, should not open
        assert breaker_fast._state == CircuitState.CLOSED

        breaker_fast._record_failure(0.01)  # window last 4 contains 2 failures => 0.5, should open
        assert breaker_fast._state == CircuitState.OPEN
        assert breaker_fast._opened_at == pytest.approx(300.0)


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker_fast):
    """Test _record_failure transitions HALF_OPEN -> OPEN immediately."""
    breaker_fast._state = CircuitState.HALF_OPEN
    with patch("src.circuit_breaker.time.time", return_value=400.0):
        breaker_fast._record_failure(0.01)
    assert breaker_fast._state == CircuitState.OPEN
    assert breaker_fast._opened_at == pytest.approx(400.0)


def test_circuit_breaker_record_success_in_half_open_closes_after_success_threshold(breaker_fast):
    """Test _record_success in HALF_OPEN closes circuit after success_threshold successes."""
    breaker_fast._state = CircuitState.HALF_OPEN
    breaker_fast._failure_count = 5
    breaker_fast._opened_at = 1.0
    breaker_fast._sliding_window.extend([False, False])

    t = iter([500.0, 501.0, 502.0, 503.0])  # last_success_time for each call and open time if needed
    with patch("src.circuit_breaker.time.time", side_effect=lambda: next(t)):
        breaker_fast._record_success(0.1)
        assert breaker_fast._state == CircuitState.HALF_OPEN
        breaker_fast._record_success(0.2)
        assert breaker_fast._state == CircuitState.CLOSED

    assert breaker_fast._failure_count == 0
    assert breaker_fast._success_count == 0
    assert breaker_fast._opened_at is None
    assert len(breaker_fast._sliding_window) == 0


def test_circuit_breaker_get_health_info_contains_expected_fields(breaker_fast):
    """Test get_health_info returns expected structure and values."""
    breaker_fast._state = CircuitState.CLOSED
    breaker_fast._failure_count = 2
    breaker_fast._success_count = 1
    breaker_fast.metrics.total_calls = 10
    breaker_fast.metrics.successful_calls = 7
    breaker_fast.metrics.failed_calls = 3
    breaker_fast.metrics.rejected_calls = 4
    breaker_fast.metrics.average_response_time = 0.123
    breaker_fast.metrics.state_transitions = 9

    # Ensure failure_rate is non-zero only when window full
    breaker_fast._sliding_window.clear()
    breaker_fast._sliding_window.extend([False, True, False, True])  # full window size 4 => rate 0.5

    info = breaker_fast.get_health_info()
    assert info["name"] == "svc_fast"
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 2
    assert info["success_count"] == 1
    assert info["failure_rate"] == pytest.approx(0.5)
    assert info["metrics"]["total_calls"] == 10
    assert info["metrics"]["successful_calls"] == 7
    assert info["metrics"]["failed_calls"] == 3
    assert info["metrics"]["rejected_calls"] == 4
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(123.0)
    assert info["metrics"]["state_transitions"] == 9
    assert info["config"]["failure_threshold"] == breaker_fast.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker_fast.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(breaker_fast.config.timeout_seconds)


def test_distributed_coordinator_init_defaults_sets_node_id_from_env(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator __init__ uses NODE_ID env when present."""
    monkeypatch.setenv("NODE_ID", "node-123")
    c = DistributedCircuitBreakerCoordinator("http://coordinator")
    assert c.coordinator_url == "http://coordinator"
    assert c.sync_interval == pytest.approx(5.0)
    assert c.node_id == "node-123"
    assert c._breakers == {}
    assert c._running is False
    assert c._sync_thread is None


def test_distributed_coordinator_register_breaker_sends_registration(coordinator, breaker_fast):
    """Test register_breaker stores breaker and calls _send_registration."""
    with patch.object(coordinator, "_send_registration") as mock_send:
        coordinator.register_breaker(breaker_fast)
    assert coordinator._breakers[breaker_fast.name] is breaker_fast
    mock_send.assert_called_once_with(breaker_fast)


def test_distributed_coordinator_send_registration_posts_json_and_ignores_urlerror(coordinator, breaker_fast):
    """Test _send_registration posts expected request and ignores URLError."""
    coordinator.node_id = "node-x"

    def urlopen_side_effect(req, timeout=5):
        raise Exception("should not be called")  # overwritten below

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = SimpleNamespace(read=lambda: b"")  # not used
        coordinator._send_registration(breaker_fast)
        assert mock_urlopen.call_count == 1
        (req,), kwargs = mock_urlopen.call_args
        assert kwargs["timeout"] == 5
        assert req.full_url == "http://coordinator/circuit-breakers/register"
        assert req.method == "POST"
        assert req.headers["Content-Type"] == "application/json"
        payload = json.loads(req.data.decode("utf-8"))
        assert payload["service"] == breaker_fast.name
        assert payload["node_id"] == "node-x"
        assert payload["failure_threshold"] == breaker_fast.config.failure_threshold
        assert payload["success_threshold"] == breaker_fast.config.success_threshold

    from urllib.error import URLError

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")) as mock_urlopen:
        coordinator._send_registration(breaker_fast)
        assert mock_urlopen.call_count == 1


def test_distributed_coordinator_start_sync_creates_daemon_thread(coordinator):
    """Test start_sync sets running and starts a daemon thread."""
    with patch("src.circuit_breaker.threading.Thread") as mock_thread_cls:
        mock_thread = Mock()
        mock_thread_cls.return_value = mock_thread

        coordinator.start_sync()

        assert coordinator._running is True
        mock_thread_cls.assert_called_once()
        _, kwargs = mock_thread_cls.call_args
        assert kwargs["target"] == coordinator._sync_loop
        assert kwargs["daemon"] is True
        mock_thread.start.assert_called_once()
        assert coordinator._sync_thread is mock_thread


def test_distributed_coordinator_stop_sync_joins_thread(coordinator):
    """Test stop_sync sets running False and joins existing thread with timeout."""
    coordinator._running = True
    mock_thread = Mock()
    coordinator._sync_thread = mock_thread

    coordinator.stop_sync()
    assert coordinator._running is False
    mock_thread.join.assert_called_once_with(timeout=2)


def test_distributed_coordinator_sync_loop_calls_synchronize_and_sleeps_and_ignores_exceptions(coordinator):
    """Test _sync_loop calls _synchronize_states, sleeps, and ignores synchronize exceptions."""
    coordinator._running = True
    call_count = {"n": 0}

    def sync_side_effect():
        call_count["n"] += 1
        raise RuntimeError("boom")

    with patch.object(coordinator, "_synchronize_states", side_effect=sync_side_effect) as _m_sync, patch(
        "src.circuit_breaker.time.sleep"
    ) as mock_sleep:

        def sleep_side_effect(_interval):
            coordinator._running = False

        mock_sleep.side_effect = sleep_side_effect
        coordinator._sync_loop()

    assert call_count["n"] == 1
    mock_sleep.assert_called_once_with(pytest.approx(coordinator.sync_interval))


def test_distributed_coordinator_synchronize_states_posts_state_and_health_info(coordinator, breaker_fast):
    """Test _synchronize_states posts expected state payload for each registered breaker."""
    coordinator.node_id = "node-1"
    coordinator._breakers = {"svc_fast": breaker_fast}
    breaker_fast._failure_count = 2
    breaker_fast._state = CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", return_value=1000.0), patch(
        "src.circuit_breaker.urllib.request.urlopen"
    ) as mock_urlopen:
        mock_urlopen.return_value = SimpleNamespace(read=lambda: b"")
        coordinator._synchronize_states()

        assert mock_urlopen.call_count == 1
        (req,), kwargs = mock_urlopen.call_args
        assert kwargs["timeout"] == 5
        assert req.full_url == "http://coordinator/circuit-breakers/state"
        assert req.method == "POST"
        assert req.headers["Content-Type"] == "application/json"

        payload = json.loads(req.data.decode("utf-8"))
        assert payload["service"] == "svc_fast"
        assert payload["node_id"] == "node-1"
        assert payload["state"] == "CLOSED"
        assert payload["failure_count"] == 2
        assert payload["timestamp"] == 1000000
        assert isinstance(payload["health_info"], dict)
        assert payload["health_info"]["name"] == "svc_fast"


def test_distributed_coordinator_synchronize_states_ignores_urlerror(coordinator, breaker_fast):
    """Test _synchronize_states ignores URLError during post."""
    from urllib.error import URLError

    coordinator._breakers = {"svc_fast": breaker_fast}
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")) as mock_urlopen:
        coordinator._synchronize_states()
        assert mock_urlopen.call_count == 1


def test_distributed_coordinator_get_cluster_state_success_returns_json(coordinator):
    """Test get_cluster_state returns decoded JSON from coordinator."""
    response_obj = SimpleNamespace(read=lambda: b'{"ok": true, "value": 2}')
    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=response_obj) as mock_urlopen:
        result = coordinator.get_cluster_state("svc")
        assert result == {"ok": True, "value": 2}
        assert mock_urlopen.call_count == 1
        (req,), kwargs = mock_urlopen.call_args
        assert kwargs["timeout"] == 5
        assert req.full_url == "http://coordinator/circuit-breakers/svc/aggregate"
        assert req.method == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    from urllib.error import URLError

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")):
        result = coordinator.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}