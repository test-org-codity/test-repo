from __future__ import annotations

import json
import threading
import urllib.error
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
    """Reset CircuitBreaker global registry to avoid cross-test pollution."""
    CircuitBreaker._registry = {}
    yield
    CircuitBreaker._registry = {}


@pytest.fixture
def default_config():
    """Create a default CircuitBreakerConfig for testing."""
    return CircuitBreakerConfig()


@pytest.fixture
def small_threshold_config():
    """Create a CircuitBreakerConfig with small thresholds for fast state transitions."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_small(small_threshold_config):
    """Create a CircuitBreaker instance with small thresholds."""
    return CircuitBreaker(name="svc", config=small_threshold_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator instance for testing."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator", sync_interval=0.01)


def test_circuit_state_enum_values():
    """Test CircuitState enum values match source."""
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


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test record_response_time appends duration and updates average_response_time."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_metrics_record_response_time_respects_maxlen():
    """Test record_response_time maintains deque maxlen=100 and average over stored values."""
    m = CircuitBreakerMetrics()
    for _ in range(100):
        m.record_response_time(1.0)
    assert len(m._response_times) == 100
    assert m.average_response_time == pytest.approx(1.0)

    m.record_response_time(3.0)
    assert len(m._response_times) == 100
    assert m.average_response_time == pytest.approx((99 * 1.0 + 3.0) / 100.0)


def test_circuit_breaker_open_error_message_and_fields():
    """Test CircuitBreakerOpenError stores fields and formats message."""
    err = CircuitBreakerOpenError("svc", 1.23456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.23456)
    assert "Circuit breaker 'svc' is open" in str(err)
    assert "Retry after 1.23s" in str(err)


def test_circuit_breaker_init_defaults(default_config):
    """Test CircuitBreaker initialization sets expected defaults."""
    b = CircuitBreaker("svc", default_config)
    assert b.name == "svc"
    assert b.config is default_config
    assert b.state == CircuitState.CLOSED
    assert b._failure_count == 0
    assert b._success_count == 0
    assert b._half_open_calls == 0
    assert b._opened_at is None
    assert b.metrics.total_calls == 0
    assert b.metrics.average_response_time == pytest.approx(0.0)
    assert len(b._sliding_window) == 0
    assert b._sliding_window.maxlen == default_config.sliding_window_size


def test_circuit_breaker_get_or_create_returns_singleton_per_name(small_threshold_config):
    """Test get_or_create returns the same instance for the same name."""
    b1 = CircuitBreaker.get_or_create("svc", small_threshold_config)
    b2 = CircuitBreaker.get_or_create("svc", CircuitBreakerConfig(failure_threshold=999))
    assert b1 is b2
    assert b1.config.failure_threshold == 2


def test_circuit_breaker_should_attempt_reset_false_when_never_opened(breaker_small):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    breaker_small._opened_at = None
    assert breaker_small._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_after_timeout(breaker_small):
    """Test _should_attempt_reset returns True when timeout has elapsed."""
    breaker_small._opened_at = 100.0
    with patch("src.circuit_breaker.time.time", return_value=111.0):
        assert breaker_small._should_attempt_reset() is True


def test_circuit_breaker_state_transitions_to_half_open_when_open_and_timeout_elapsed(breaker_small):
    """Test state property moves from OPEN to HALF_OPEN after timeout."""
    with patch("src.circuit_breaker.time.time", return_value=100.0):
        breaker_small._transition_to(CircuitState.OPEN)

    with patch("src.circuit_breaker.time.time", return_value=111.0):
        assert breaker_small.state == CircuitState.HALF_OPEN
        assert breaker_small._state == CircuitState.HALF_OPEN
        assert breaker_small._half_open_calls == 0


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(breaker_small):
    """Test _transition_to(OPEN) sets opened_at time and increments state_transitions."""
    with patch("src.circuit_breaker.time.time", return_value=123.0):
        breaker_small._transition_to(CircuitState.OPEN)
    assert breaker_small._opened_at == pytest.approx(123.0)
    assert breaker_small.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_half_open_calls_and_success_count(breaker_small):
    """Test _transition_to(HALF_OPEN) resets half-open counters."""
    breaker_small._half_open_calls = 2
    breaker_small._success_count = 5
    breaker_small._transition_to(CircuitState.HALF_OPEN)
    assert breaker_small._half_open_calls == 0
    assert breaker_small._success_count == 0
    assert breaker_small.state == CircuitState.HALF_OPEN


def test_circuit_breaker_transition_to_closed_resets_counts_and_clears_sliding_window(breaker_small):
    """Test _transition_to(CLOSED) clears counts, opened_at, and sliding window."""
    breaker_small._failure_count = 10
    breaker_small._success_count = 3
    breaker_small._opened_at = 99.0
    breaker_small._sliding_window.append(False)
    breaker_small._sliding_window.append(True)

    breaker_small._transition_to(CircuitState.CLOSED)
    assert breaker_small._failure_count == 0
    assert breaker_small._success_count == 0
    assert breaker_small._opened_at is None
    assert len(breaker_small._sliding_window) == 0
    assert breaker_small.state == CircuitState.CLOSED


def test_circuit_breaker_allow_request_closed_true(breaker_small):
    """Test _allow_request returns True in CLOSED state."""
    assert breaker_small.state == CircuitState.CLOSED
    assert breaker_small._allow_request() is True


def test_circuit_breaker_allow_request_open_false(breaker_small):
    """Test _allow_request returns False in OPEN state."""
    breaker_small._transition_to(CircuitState.OPEN)
    assert breaker_small._allow_request() is False


def test_circuit_breaker_allow_request_half_open_limited_by_max_calls(breaker_small):
    """Test _allow_request in HALF_OPEN allows only up to half_open_max_calls."""
    breaker_small._transition_to(CircuitState.HALF_OPEN)
    assert breaker_small._allow_request() is True
    assert breaker_small._half_open_calls == 1
    assert breaker_small._allow_request() is True
    assert breaker_small._half_open_calls == 2
    assert breaker_small._allow_request() is False
    assert breaker_small._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_sliding_window(breaker_small):
    """Test execute on success increments metrics and records response time."""
    op = Mock(return_value="ok")

    times = [100.0, 100.25, 100.25]  # start, end duration calc, last_success_time
    with patch("src.circuit_breaker.time.time", side_effect=times):
        result = breaker_small.execute(op)

    assert result == "ok"
    op.assert_called_once()
    assert breaker_small.metrics.total_calls == 1
    assert breaker_small.metrics.successful_calls == 1
    assert breaker_small.metrics.failed_calls == 0
    assert breaker_small.metrics.average_response_time == pytest.approx(0.25)
    assert list(breaker_small._sliding_window) == [True]


def test_circuit_breaker_execute_failure_records_metrics_and_raises(breaker_small):
    """Test execute on failure increments metrics, records response time, and re-raises."""

    def op():
        raise ValueError("boom")

    times = [50.0, 50.1, 50.1]  # start, end duration calc, last_failure_time
    with patch("src.circuit_breaker.time.time", side_effect=times):
        with pytest.raises(ValueError, match="boom"):
            breaker_small.execute(op)

    assert breaker_small.metrics.total_calls == 1
    assert breaker_small.metrics.successful_calls == 0
    assert breaker_small.metrics.failed_calls == 1
    assert breaker_small.metrics.average_response_time == pytest.approx(0.1)
    assert list(breaker_small._sliding_window) == [False]


def test_circuit_breaker_execute_rejected_increments_rejected_and_raises_open_error(breaker_small):
    """Test execute rejects when OPEN and raises CircuitBreakerOpenError with remaining time."""
    breaker_small._transition_to(CircuitState.OPEN)
    breaker_small._opened_at = 100.0

    with patch("src.circuit_breaker.time.time", return_value=105.0):
        with pytest.raises(CircuitBreakerOpenError) as ei:
            breaker_small.execute(lambda: "nope")

    assert breaker_small.metrics.rejected_calls == 1
    err = ei.value
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(5.0)


def test_circuit_breaker_execute_rejected_uses_fallback_when_provided(breaker_small):
    """Test execute returns fallback result when request is rejected."""
    breaker_small._transition_to(CircuitState.OPEN)
    breaker_small._opened_at = 100.0

    fallback = Mock(return_value="fb")
    with patch("src.circuit_breaker.time.time", return_value=101.0):
        assert breaker_small.execute(lambda: "nope", fallback=fallback) == "fb"

    fallback.assert_called_once()
    assert breaker_small.metrics.rejected_calls == 1
    assert breaker_small.metrics.total_calls == 0  # rejected returns before counting total_calls


def test_circuit_breaker_execute_rejected_remaining_time_clamped_to_zero(breaker_small):
    """
    Test execute remaining time is clamped to 0 when negative due to time drift.

    If the implementation transitions to HALF_OPEN once the timeout has elapsed,
    there is no rejection to raise; we force rejection by keeping it OPEN while
    setting opened_at in the future, producing negative remaining time which must
    be clamped to 0.
    """
    breaker_small.config.timeout_seconds = 1.0
    breaker_small._transition_to(CircuitState.OPEN)
    breaker_small._opened_at = 500.0  # future opened_at creates negative remaining time

    with patch("src.circuit_breaker.time.time", return_value=200.0):
        with pytest.raises(CircuitBreakerOpenError) as ei:
            breaker_small.execute(lambda: "nope")

    assert ei.value.remaining_time == pytest.approx(0.0)


def test_circuit_breaker_record_success_in_closed_decrements_failure_count_not_below_zero(breaker_small):
    """Test _record_success in CLOSED decrements failure_count but not below 0."""
    breaker_small._failure_count = 0
    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker_small._record_success(0.2)
    assert breaker_small._failure_count == 0

    breaker_small._failure_count = 2
    with patch("src.circuit_breaker.time.time", return_value=11.0):
        breaker_small._record_success(0.2)
    assert breaker_small._failure_count == 1


def test_circuit_breaker_record_success_in_half_open_closes_after_success_threshold(breaker_small):
    """Test _record_success in HALF_OPEN transitions to CLOSED after success_threshold."""
    breaker_small._transition_to(CircuitState.OPEN)
    breaker_small._transition_to(CircuitState.HALF_OPEN)

    with patch("src.circuit_breaker.time.time", return_value=1.0):
        breaker_small._record_success(0.1)
    assert breaker_small.state == CircuitState.HALF_OPEN
    assert breaker_small._success_count == 1

    with patch("src.circuit_breaker.time.time", return_value=2.0):
        breaker_small._record_success(0.2)
    assert breaker_small.state == CircuitState.CLOSED
    assert breaker_small._failure_count == 0
    assert breaker_small._success_count == 0
    assert len(breaker_small._sliding_window) == 0


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker_small):
    """
    Test _record_failure in HALF_OPEN transitions immediately to OPEN.

    Some implementations evaluate reset timeout on state access and may auto-transition.
    We explicitly keep it HALF_OPEN during the call by ensuring opened_at is None.
    """
    breaker_small._transition_to(CircuitState.HALF_OPEN)
    breaker_small._opened_at = None
    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker_small._record_failure(0.1)

    assert breaker_small._state == CircuitState.OPEN
    assert breaker_small._opened_at == pytest.approx(10.0)


def test_circuit_breaker_calculate_failure_rate_returns_zero_until_window_full(breaker_small):
    """Test _calculate_failure_rate returns 0.0 until sliding window reaches configured size."""
    breaker_small._sliding_window.clear()
    breaker_small._sliding_window.extend([False, False, True])  # size 3 < 4
    assert breaker_small._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_computes_when_window_full(breaker_small):
    """Test _calculate_failure_rate returns failures/len once window is full."""
    breaker_small._sliding_window.clear()
    breaker_small._sliding_window.extend([False, True, False, True])
    assert breaker_small._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_record_failure_opens_on_failure_threshold(breaker_small):
    """
    Test failures open circuit when failure_count reaches failure_threshold.

    Use internal state to avoid auto-transition to HALF_OPEN on state property access
    (some implementations transition on read after timeout).
    """
    breaker_small._transition_to(CircuitState.CLOSED)
    with patch("src.circuit_breaker.time.time", return_value=1.0):
        breaker_small._record_failure(0.1)
    assert breaker_small._state == CircuitState.CLOSED
    assert breaker_small._failure_count == 1

    with patch("src.circuit_breaker.time.time", return_value=2.0):
        breaker_small._record_failure(0.1)
    assert breaker_small._state == CircuitState.OPEN
    assert breaker_small._failure_count == 2


def test_circuit_breaker_record_failure_opens_on_failure_rate_threshold(breaker_small):
    """
    Test failures open circuit when failure rate threshold exceeded (requires full window).

    Validate against internal state to avoid auto-transition side effects on read.
    """
    cfg = CircuitBreakerConfig(
        failure_threshold=999,  # make count threshold unreachable
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    b = CircuitBreaker("svc", cfg)

    with patch("src.circuit_breaker.time.time", return_value=1.0):
        b._record_failure(0.1)
    assert b._state == CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", return_value=2.0):
        b._record_failure(0.1)
    assert b._state == CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", return_value=3.0):
        b._record_success(0.1)
    assert b._state == CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", return_value=4.0):
        b._record_failure(0.1)
    assert list(b._sliding_window) == [False, False, True, False]
    assert b._calculate_failure_rate() == pytest.approx(0.75)
    assert b._state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_structure_and_values(breaker_small):
    """Test get_health_info returns correct structure and uses ms conversion for average_response_time."""
    breaker_small._failure_count = 1
    breaker_small._success_count = 2
    breaker_small._sliding_window.clear()
    breaker_small._sliding_window.extend([True, False, True, False])
    breaker_small.metrics.total_calls = 10
    breaker_small.metrics.successful_calls = 7
    breaker_small.metrics.failed_calls = 3
    breaker_small.metrics.rejected_calls = 2
    breaker_small.metrics.average_response_time = 0.123

    info = breaker_small.get_health_info()
    assert info["name"] == "svc"
    assert info["state"] == breaker_small.state.value
    assert info["failure_count"] == 1
    assert info["success_count"] == 2
    assert info["failure_rate"] == pytest.approx(0.5)

    metrics = info["metrics"]
    assert metrics["total_calls"] == 10
    assert metrics["successful_calls"] == 7
    assert metrics["failed_calls"] == 3
    assert metrics["rejected_calls"] == 2
    assert metrics["average_response_time_ms"] == pytest.approx(123.0)
    assert "state_transitions" in metrics

    cfg = info["config"]
    assert cfg["failure_threshold"] == breaker_small.config.failure_threshold
    assert cfg["success_threshold"] == breaker_small.config.success_threshold
    assert cfg["timeout_seconds"] == pytest.approx(breaker_small.config.timeout_seconds)


def test_distributed_coordinator_init_defaults_and_node_id_from_env(monkeypatch):
    """Test coordinator initializes node_id from NODE_ID env var when present."""
    monkeypatch.setenv("NODE_ID", "node-xyz")
    c = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=1.5)
    assert c.coordinator_url == "http://coordinator"
    assert c.sync_interval == pytest.approx(1.5)
    assert c.node_id == "node-xyz"
    assert c._breakers == {}
    assert c._running is False
    assert c._sync_thread is None


def test_distributed_coordinator_register_breaker_sends_registration(coordinator, breaker_small):
    """Test register_breaker stores breaker and calls _send_registration."""
    with patch.object(coordinator, "_send_registration") as mock_send:
        coordinator.register_breaker(breaker_small)

    assert coordinator._breakers["svc"] is breaker_small
    mock_send.assert_called_once_with(breaker_small)


def test_distributed_coordinator_send_registration_posts_json_and_ignores_urlerror(coordinator, breaker_small):
    """Test _send_registration posts expected JSON and ignores URLError."""
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["data"] = req.data
        captured["method"] = req.method
        captured["headers"] = dict(req.header_items())
        return Mock()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as m:
        coordinator._send_registration(breaker_small)

    assert captured["url"] == "http://coordinator/circuit-breakers/register"
    assert captured["timeout"] == 5
    assert captured["method"] == "POST"
    assert captured["headers"]["Content-type"] == "application/json"

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["service"] == "svc"
    assert payload["node_id"] == coordinator.node_id
    assert payload["failure_threshold"] == breaker_small.config.failure_threshold
    assert payload["success_threshold"] == breaker_small.config.success_threshold
    m.assert_called_once()

    with patch(
        "src.circuit_breaker.urllib.request.urlopen",
        side_effect=urllib.error.URLError("down"),
    ):
        coordinator._send_registration(breaker_small)


def test_distributed_coordinator_synchronize_states_posts_each_breaker_state(coordinator, breaker_small):
    """Test _synchronize_states sends state payload for registered breakers."""
    coordinator.register_breaker = DistributedCircuitBreakerCoordinator.register_breaker.__get__(coordinator)
    with patch.object(coordinator, "_send_registration"):
        coordinator.register_breaker(breaker_small)

    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["data"] = req.data
        captured["method"] = req.method
        captured["headers"] = dict(req.header_items())
        return Mock()

    with patch("src.circuit_breaker.time.time", return_value=123.456), patch(
        "src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen
    ):
        coordinator._synchronize_states()

    assert captured["url"] == "http://coordinator/circuit-breakers/state"
    assert captured["timeout"] == 5
    assert captured["method"] == "POST"
    assert captured["headers"]["Content-type"] == "application/json"

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["service"] == "svc"
    assert payload["node_id"] == coordinator.node_id
    assert payload["state"] == breaker_small.state.value
    assert payload["failure_count"] == breaker_small._failure_count
    assert payload["timestamp"] == 123456
    assert payload["health_info"]["name"] == "svc"


def test_distributed_coordinator_synchronize_states_ignores_urlerror(coordinator, breaker_small):
    """Test _synchronize_states ignores URLError and continues."""
    with patch.object(coordinator, "_send_registration"):
        coordinator.register_breaker(breaker_small)

    with patch(
        "src.circuit_breaker.urllib.request.urlopen",
        side_effect=urllib.error.URLError("down"),
    ):
        coordinator._synchronize_states()


def test_distributed_coordinator_start_sync_creates_daemon_thread(coordinator):
    """
    Test start_sync creates and starts a daemon thread.

    Use a simple dummy thread object instead of Mock(spec=threading.Thread), because
    patching threading.Thread can turn threading.Thread into a Mock, which then
    makes spec invalid ("Cannot spec a Mock object").
    """
    created = {}

    class DummyThread:
        def __init__(self, *, target, daemon):
            self._target = target
            self.daemon = daemon
            self.start = Mock()
            self.join = Mock()

    def fake_thread(*, target, daemon):
        t = DummyThread(target=target, daemon=daemon)
        created["thread"] = t
        created["target"] = target
        created["daemon"] = daemon
        return t

    with patch("src.circuit_breaker.threading.Thread", side_effect=fake_thread):
        coordinator.start_sync()

    assert coordinator._running is True
    assert coordinator._sync_thread is created["thread"]
    assert created["daemon"] is True
    assert callable(created["target"])
    created["thread"].start.assert_called_once()


def test_distributed_coordinator_stop_sync_joins_thread(coordinator):
    """Test stop_sync sets running False and joins existing thread."""
    t = Mock(spec=threading.Thread)
    coordinator._sync_thread = t
    coordinator._running = True

    coordinator.stop_sync()

    assert coordinator._running is False
    t.join.assert_called_once_with(timeout=2)


def test_distributed_coordinator_sync_loop_calls_synchronize_and_sleeps_until_stopped(coordinator):
    """Test _sync_loop calls _synchronize_states and sleeps; exits when _running becomes False."""
    coordinator.sync_interval = 0.5
    coordinator._running = True

    def stop_after_one_call():
        coordinator._running = False

    with patch.object(coordinator, "_synchronize_states", side_effect=stop_after_one_call) as sync_mock, patch(
        "src.circuit_breaker.time.sleep"
    ) as sleep_mock:
        coordinator._sync_loop()

    sync_mock.assert_called_once()
    sleep_mock.assert_called_once_with(0.5)


def test_distributed_coordinator_sync_loop_ignores_exceptions_and_continues(coordinator):
    """Test _sync_loop ignores exceptions from _synchronize_states and still sleeps."""
    coordinator.sync_interval = 0.1
    coordinator._running = True
    call_count = {"n": 0}

    def side_effect():
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("boom")
        coordinator._running = False

    with patch.object(coordinator, "_synchronize_states", side_effect=side_effect) as sync_mock, patch(
        "src.circuit_breaker.time.sleep"
    ) as sleep_mock:
        coordinator._sync_loop()

    assert sync_mock.call_count == 2
    assert sleep_mock.call_count == 2


def test_distributed_coordinator_get_cluster_state_success_returns_json(coordinator):
    """Test get_cluster_state returns parsed JSON on successful response."""
    resp = Mock()
    resp.read.return_value = b'{"ok": true, "value": 123}'
    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=resp) as m:
        data = coordinator.get_cluster_state("svc")

    assert data == {"ok": True, "value": 123}
    req = m.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/svc/aggregate"
    assert req.method == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        data = coordinator.get_cluster_state("svc")
    assert data == {"error": "Failed to fetch cluster state"}