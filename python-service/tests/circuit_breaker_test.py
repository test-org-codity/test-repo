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
    circuit_breaker,
)


@pytest.fixture(autouse=True)
def reset_circuit_breaker_registry():
    """Reset global CircuitBreaker registry to avoid cross-test contamination."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig instance."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=default_config)


@pytest.fixture
def small_window_config():
    """Provide a config with a small sliding window for failure-rate tests."""
    return CircuitBreakerConfig(
        failure_threshold=100,  # prevent count-based open, rely on failure rate
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_small_window(small_window_config):
    """Create a CircuitBreaker with a small sliding window."""
    return CircuitBreaker(name="rate-breaker", config=small_window_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator instance for testing."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator", sync_interval=0.01)


def test_circuit_state_enum_values():
    """Test CircuitState enum has expected string values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test CircuitBreakerConfig initializes with expected defaults."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == 30.0
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == 0.5


def test_circuit_breaker_metrics_record_response_time_average_updates():
    """Test CircuitBreakerMetrics.record_response_time updates average response time."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    assert m.average_response_time == pytest.approx(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_open_error_contains_name_and_remaining_time():
    """Test CircuitBreakerOpenError stores provided fields and formats message."""
    err = CircuitBreakerOpenError("svc", 1.2345)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.2345)
    assert "Circuit breaker 'svc' is open" in str(err)
    assert "Retry after" in str(err)


def test_circuit_breaker_init_defaults_state_and_counters(default_config):
    """Test CircuitBreaker initializes with expected state, counters, window, and metrics."""
    b = CircuitBreaker("svc", default_config)
    assert b.name == "svc"
    assert b.config is default_config
    assert b.state == CircuitState.CLOSED
    assert b._failure_count == 0
    assert b._success_count == 0
    assert b._half_open_calls == 0
    assert b._opened_at is None
    assert b.metrics.total_calls == 0
    assert b.metrics.successful_calls == 0
    assert b.metrics.failed_calls == 0
    assert b.metrics.rejected_calls == 0
    assert b.metrics.state_transitions == 0
    assert len(b._sliding_window) == 0
    assert b._sliding_window.maxlen == default_config.sliding_window_size


def test_circuit_breaker_get_or_create_returns_same_instance_for_same_name(default_config):
    """Test get_or_create returns the same instance for the same name."""
    b1 = CircuitBreaker.get_or_create("svc", default_config)
    b2 = CircuitBreaker.get_or_create("svc", CircuitBreakerConfig(failure_threshold=1))
    assert b1 is b2
    assert b1.name == "svc"
    assert b2.name == "svc"


def test_circuit_breaker_state_open_transitions_to_half_open_after_timeout(breaker):
    """Test state property transitions from OPEN to HALF_OPEN after timeout expires."""
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at is not None

    with patch("src.circuit_breaker.time.time", return_value=breaker._opened_at + breaker.config.timeout_seconds - 0.0001):
        assert breaker.state == CircuitState.OPEN

    with patch("src.circuit_breaker.time.time", return_value=breaker._opened_at + breaker.config.timeout_seconds + 0.0001):
        assert breaker.state == CircuitState.HALF_OPEN
        assert breaker._half_open_calls == 0
        assert breaker._success_count == 0


def test_circuit_breaker__should_attempt_reset_false_when_no_opened_at(breaker):
    """Test _should_attempt_reset returns False if opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker__should_attempt_reset_true_after_timeout(breaker):
    """Test _should_attempt_reset returns True when open duration exceeds timeout."""
    breaker._opened_at = 100.0
    with patch("src.circuit_breaker.time.time", return_value=100.0 + breaker.config.timeout_seconds):
        assert breaker._should_attempt_reset() is True


def test_circuit_breaker__transition_to_open_sets_opened_at_and_increments_transitions(breaker):
    """Test _transition_to(OPEN) sets opened_at and increments transition metric."""
    with patch("src.circuit_breaker.time.time", return_value=123.456):
        breaker._transition_to(CircuitState.OPEN)

    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(123.456)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker__transition_to_half_open_resets_half_open_calls_and_success_count(breaker):
    """Test _transition_to(HALF_OPEN) resets half-open call counter and success count."""
    breaker._half_open_calls = 99
    breaker._success_count = 42
    breaker._transition_to(CircuitState.HALF_OPEN)

    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker__transition_to_closed_resets_counters_and_clears_window(breaker):
    """Test _transition_to(CLOSED) resets counts, opened_at, and clears sliding window."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._opened_at = 111.0
    breaker._sliding_window.append(False)
    breaker._sliding_window.append(True)

    breaker._transition_to(CircuitState.CLOSED)

    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_execute_success_records_metrics_and_returns_value(breaker):
    """Test execute records success metrics and returns operation result."""
    with patch("src.circuit_breaker.time.time", side_effect=[100.0, 100.05, 100.051]):
        result = breaker.execute(lambda: "ok")

    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.last_success_time == pytest.approx(100.051)
    assert breaker.metrics.average_response_time == pytest.approx(0.05)
    assert breaker.state == CircuitState.CLOSED
    assert len(breaker._sliding_window) == 1
    assert breaker._sliding_window[-1] is True


def test_circuit_breaker_execute_failure_records_metrics_and_reraises(breaker):
    """Test execute records failure metrics and re-raises the underlying exception."""
    def op():
        raise ValueError("boom")

    with patch("src.circuit_breaker.time.time", side_effect=[200.0, 200.02, 200.021]):
        with pytest.raises(ValueError, match="boom"):
            breaker.execute(op)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.last_failure_time == pytest.approx(200.021)
    assert breaker.metrics.average_response_time == pytest.approx(0.02)
    assert len(breaker._sliding_window) == 1
    assert breaker._sliding_window[-1] is False


def test_circuit_breaker_execute_open_rejects_and_raises_open_error_with_remaining_time(breaker):
    """Test execute rejects when open and raises CircuitBreakerOpenError with remaining time."""
    breaker._transition_to(CircuitState.OPEN)

    opened_at = breaker._opened_at
    assert opened_at is not None

    with patch("src.circuit_breaker.time.time", return_value=opened_at + 10.0):
        with pytest.raises(CircuitBreakerOpenError) as exc:
            breaker.execute(lambda: "should-not-run")

    assert breaker.metrics.rejected_calls == 1
    assert exc.value.name == breaker.name
    assert exc.value.remaining_time == pytest.approx(breaker.config.timeout_seconds - 10.0)


def test_circuit_breaker_execute_open_rejects_and_calls_fallback(breaker):
    """Test execute calls fallback and does not raise when open."""
    breaker._transition_to(CircuitState.OPEN)
    fallback = Mock(return_value="fallback")

    with patch("src.circuit_breaker.time.time", return_value=(breaker._opened_at or 0) + 1.0):
        result = breaker.execute(lambda: "should-not-run", fallback=fallback)

    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1
    fallback.assert_called_once_with()
    assert breaker.metrics.total_calls == 0  # rejected calls do not increment total_calls in execute()


def test_circuit_breaker__allow_request_closed_allows(breaker):
    """Test _allow_request returns True in CLOSED state."""
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._allow_request() is True


def test_circuit_breaker__allow_request_open_denies(breaker):
    """Test _allow_request returns False in OPEN state."""
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._allow_request() is False


def test_circuit_breaker__allow_request_half_open_allows_up_to_max_and_tracks_calls(breaker):
    """Test _allow_request in HALF_OPEN allows up to max calls and then denies."""
    breaker.config.half_open_max_calls = 2
    breaker._transition_to(CircuitState.HALF_OPEN)

    assert breaker._half_open_calls == 0
    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 1
    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 2
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == 2


def test_circuit_breaker__record_success_half_open_closes_after_success_threshold(breaker):
    """Test _record_success in HALF_OPEN transitions to CLOSED after enough successes."""
    breaker.config.success_threshold = 2
    breaker._transition_to(CircuitState.OPEN)
    breaker._transition_to(CircuitState.HALF_OPEN)

    with patch("src.circuit_breaker.time.time", return_value=300.0):
        breaker._record_success(0.01)
        assert breaker.state == CircuitState.HALF_OPEN
        breaker._record_success(0.02)

    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0  # cleared on close transition
    assert breaker.metrics.successful_calls == 2
    assert breaker.metrics.average_response_time == pytest.approx((0.01 + 0.02) / 2)


def test_circuit_breaker__record_failure_half_open_opens_immediately(breaker):
    """Test _record_failure in HALF_OPEN transitions back to OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    with patch("src.circuit_breaker.time.time", return_value=400.0):
        breaker._record_failure(0.5)

    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(400.0)
    assert breaker.metrics.failed_calls == 1


def test_circuit_breaker__record_failure_closed_opens_on_failure_threshold(breaker):
    """Test _record_failure transitions to OPEN when failure_threshold is reached."""
    breaker.config.failure_threshold = 2
    breaker.config.sliding_window_size = 10  # keep default behavior
    breaker._sliding_window = breaker._sliding_window.__class__(maxlen=breaker.config.sliding_window_size)

    with patch("src.circuit_breaker.time.time", return_value=500.0):
        breaker._record_failure(0.01)
        assert breaker.state == CircuitState.CLOSED
        breaker._record_failure(0.01)

    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(500.0)


def test_circuit_breaker__calculate_failure_rate_returns_zero_until_window_full(breaker_small_window):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full."""
    b = breaker_small_window
    assert b._calculate_failure_rate() == pytest.approx(0.0)
    with patch("src.circuit_breaker.time.time", return_value=1.0):
        b._record_failure(0.01)
        b._record_failure(0.01)
        b._record_success(0.01)
    assert len(b._sliding_window) == 3
    assert b._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker__calculate_failure_rate_correct_when_window_full(breaker_small_window):
    """Test _calculate_failure_rate computes failures/window_size once full."""
    b = breaker_small_window
    with patch("src.circuit_breaker.time.time", return_value=2.0):
        b._record_failure(0.01)
        b._record_success(0.01)
        b._record_failure(0.01)
        b._record_success(0.01)
    assert len(b._sliding_window) == b.config.sliding_window_size
    assert b._calculate_failure_rate() == pytest.approx(2 / 4)


def test_circuit_breaker__record_failure_closed_opens_on_failure_rate_threshold(breaker_small_window):
    """Test _record_failure opens circuit if sliding-window failure rate exceeds threshold."""
    b = breaker_small_window
    b.config.failure_rate_threshold = 0.5
    b.config.failure_threshold = 100  # rely on rate

    with patch("src.circuit_breaker.time.time", return_value=10.0):
        b._record_failure(0.01)  # window: F
        b._record_failure(0.01)  # window: F F
        b._record_success(0.01)  # window: F F T
        assert b.state == CircuitState.CLOSED  # not full yet => rate 0.0
        b._record_failure(0.01)  # window full: F F T F => rate 0.75 => open

    assert b.state == CircuitState.OPEN
    assert b._calculate_failure_rate() == pytest.approx(3 / 4)
    assert b._opened_at == pytest.approx(10.0)


def test_circuit_breaker__record_success_closed_decrements_failure_count_not_below_zero(breaker):
    """Test _record_success in CLOSED decrements failure_count but not below zero."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._failure_count = 0
    with patch("src.circuit_breaker.time.time", return_value=600.0):
        breaker._record_success(0.01)
    assert breaker._failure_count == 0

    breaker._failure_count = 2
    with patch("src.circuit_breaker.time.time", return_value=601.0):
        breaker._record_success(0.01)
    assert breaker._failure_count == 1


def test_circuit_breaker_get_health_info_structure_and_values(breaker):
    """Test get_health_info returns expected structure and key values."""
    breaker.config.timeout_seconds = 30.0
    with patch("src.circuit_breaker.time.time", side_effect=[700.0, 700.01, 700.02, 700.03]):
        breaker.execute(lambda: "ok")
        with pytest.raises(RuntimeError):
            breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))

    info = breaker.get_health_info()
    assert info["name"] == "test-breaker"
    assert info["state"] == CircuitState.CLOSED.value
    assert info["failure_count"] == breaker._failure_count
    assert info["success_count"] == breaker._success_count
    assert info["failure_rate"] == pytest.approx(0.0)  # window not full

    assert "metrics" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 1
    assert info["metrics"]["rejected_calls"] == 0
    assert info["metrics"]["state_transitions"] == breaker.metrics.state_transitions
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(breaker.metrics.average_response_time * 1000)

    assert "config" in info
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(30.0)


def test_distributed_coordinator_init_sets_node_id_from_env(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator uses NODE_ID env var when present."""
    monkeypatch.setenv("NODE_ID", "node-123")
    c = DistributedCircuitBreakerCoordinator("http://coordinator")
    assert c.node_id == "node-123"
    assert c.coordinator_url == "http://coordinator"


def test_distributed_coordinator_register_breaker_stores_and_sends_registration(coordinator, breaker):
    """Test register_breaker stores breaker and calls _send_registration."""
    coordinator._send_registration = Mock()
    coordinator.register_breaker(breaker)
    assert coordinator._breakers[breaker.name] is breaker
    coordinator._send_registration.assert_called_once_with(breaker)


def test_distributed_coordinator__send_registration_posts_json_and_ignores_urlerror(coordinator, breaker):
    """Test _send_registration posts expected payload and ignores URLError."""
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["method"] = req.get_method()
        captured["headers"] = dict(req.header_items())
        captured["data"] = req.data
        return SimpleNamespace(read=lambda: b"")

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as m:
        coordinator._send_registration(breaker)

    assert captured["url"] == "http://coordinator/circuit-breakers/register"
    assert captured["timeout"] == 5
    assert captured["method"] == "POST"
    assert captured["headers"]["Content-Type"] == "application/json"

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["service"] == breaker.name
    assert payload["node_id"] == coordinator.node_id
    assert payload["failure_threshold"] == breaker.config.failure_threshold
    assert payload["success_threshold"] == breaker.config.success_threshold
    assert m.call_count == 1

    import urllib.error

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._send_registration(breaker)


def test_distributed_coordinator_start_sync_creates_daemon_thread(coordinator):
    """Test start_sync sets running and starts a daemon thread."""
    started = {"called": False, "daemon": None, "target": None}

    class FakeThread:
        def __init__(self, target, daemon):
            started["target"] = target
            started["daemon"] = daemon

        def start(self):
            started["called"] = True

        def join(self, timeout=None):
            return None

    with patch("src.circuit_breaker.threading.Thread", side_effect=lambda target, daemon: FakeThread(target, daemon)):
        coordinator.start_sync()

    assert coordinator._running is True
    assert coordinator._sync_thread is not None
    assert started["daemon"] is True
    assert started["called"] is True
    assert started["target"] == coordinator._sync_loop


def test_distributed_coordinator_stop_sync_joins_thread_when_present(coordinator):
    """Test stop_sync stops running and joins an existing thread."""
    thread = Mock()
    coordinator._sync_thread = thread
    coordinator._running = True
    coordinator.stop_sync()
    assert coordinator._running is False
    thread.join.assert_called_once()
    assert thread.join.call_args.kwargs.get("timeout") == 2


def test_distributed_coordinator__sync_loop_calls_synchronize_and_sleeps_until_stopped(coordinator):
    """Test _sync_loop calls _synchronize_states and sleeps each iteration until stopped."""
    calls = {"sync": 0, "sleep": 0}

    def fake_sync():
        calls["sync"] += 1
        coordinator._running = False  # stop after one iteration

    def fake_sleep(_):
        calls["sleep"] += 1

    coordinator._running = True
    with patch("src.circuit_breaker.time.sleep", side_effect=fake_sleep), patch.object(
        coordinator, "_synchronize_states", side_effect=fake_sync
    ):
        coordinator._sync_loop()

    assert calls["sync"] == 1
    assert calls["sleep"] == 1


def test_distributed_coordinator__sync_loop_ignores_exceptions_in_synchronize(coordinator):
    """Test _sync_loop ignores exceptions raised by _synchronize_states."""
    calls = {"sync": 0, "sleep": 0}

    def fake_sync():
        calls["sync"] += 1
        raise RuntimeError("boom")

    def fake_sleep(_):
        calls["sleep"] += 1
        coordinator._running = False  # stop after first sleep

    coordinator._running = True
    with patch("src.circuit_breaker.time.sleep", side_effect=fake_sleep), patch.object(
        coordinator, "_synchronize_states", side_effect=fake_sync
    ):
        coordinator._sync_loop()

    assert calls["sync"] == 1
    assert calls["sleep"] == 1


def test_distributed_coordinator__synchronize_states_posts_state_per_breaker_and_ignores_urlerror(
    coordinator, breaker
):
    """Test _synchronize_states posts breaker state and ignores URLError failures."""
    coordinator._breakers = {breaker.name: breaker}
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["method"] = req.get_method()
        captured["headers"] = dict(req.header_items())
        captured["data"] = req.data
        return SimpleNamespace(read=lambda: b"")

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen):
        with patch("src.circuit_breaker.time.time", return_value=1234.567):
            coordinator._synchronize_states()

    assert captured["url"] == "http://coordinator/circuit-breakers/state"
    assert captured["timeout"] == 5
    assert captured["method"] == "POST"
    assert captured["headers"]["Content-Type"] == "application/json"

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["service"] == breaker.name
    assert payload["node_id"] == coordinator.node_id
    assert payload["state"] == breaker.state.value
    assert payload["failure_count"] == breaker._failure_count
    assert payload["timestamp"] == int(1234.567 * 1000)
    assert isinstance(payload["health_info"], dict)
    assert payload["health_info"]["name"] == breaker.name

    import urllib.error

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._synchronize_states()


def test_distributed_coordinator_get_cluster_state_success_parses_json(coordinator):
    """Test get_cluster_state returns parsed JSON on successful response."""
    response_obj = SimpleNamespace(read=lambda: b'{"ok": true, "count": 2}')

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=response_obj) as m:
        result = coordinator.get_cluster_state("svcA")

    assert result == {"ok": True, "count": 2}
    req = m.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/svcA/aggregate"
    assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict when urlopen raises URLError."""
    import urllib.error

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        result = coordinator.get_cluster_state("svcB")

    assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_function_and_attaches_breaker():
    """Test circuit_breaker decorator wraps the function and attaches breaker attribute."""
    cfg = CircuitBreakerConfig(failure_threshold=2)
    decorator = circuit_breaker("decorated-svc", cfg)

    @decorator
    def add(a, b):
        return a + b

    assert getattr(add, "__wrapped__") is not None
    assert add.__wrapped__(2, 3) == 5
    assert hasattr(add, "circuit_breaker")
    assert isinstance(add.circuit_breaker, CircuitBreaker)
    assert add.circuit_breaker.name == "decorated-svc"

    with patch.object(add.circuit_breaker, "execute", wraps=add.circuit_breaker.execute) as exec_spy:
        assert add(2, 4) == 6
        assert exec_spy.call_count == 1