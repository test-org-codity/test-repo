import json
import os
import urllib.error
import urllib.request
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
    """Reset CircuitBreaker global registry between tests to avoid cross-test contamination."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Create a default configuration instance for testing."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="svc", config=default_config)


@pytest.fixture
def small_window_config():
    """Create a config with a small sliding window for failure-rate tests."""
    return CircuitBreakerConfig(
        failure_threshold=100,  # prevent opening due to count threshold
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_small_window(small_window_config):
    """Create a CircuitBreaker with small sliding window for failure-rate scenarios."""
    return CircuitBreaker(name="svc-rate", config=small_window_config)


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
    """Test CircuitBreakerConfig default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test CircuitBreakerMetrics.record_response_time computes running average."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    assert m.average_response_time == pytest.approx(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)
    m.record_response_time(0.2)
    assert m.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_open_error_message_and_fields():
    """Test CircuitBreakerOpenError stores name/remaining_time and message includes formatted remaining time."""
    err = CircuitBreakerOpenError("svc", 1.23456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.23456)
    assert "Circuit breaker 'svc' is open. Retry after 1.23s" in str(err)


def test_circuit_breaker_init_defaults_state_and_counters(default_config):
    """Test CircuitBreaker initializes in CLOSED state with zero counters and metrics."""
    cb = CircuitBreaker("svc-init", default_config)
    assert cb.name == "svc-init"
    assert cb.config is default_config
    assert cb.state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._half_open_calls == 0
    assert cb._opened_at is None
    assert cb.metrics.total_calls == 0
    assert cb.metrics.successful_calls == 0
    assert cb.metrics.failed_calls == 0
    assert cb.metrics.rejected_calls == 0
    assert cb.metrics.state_transitions == 0
    assert cb.metrics.average_response_time == pytest.approx(0.0)


def test_circuit_breaker_get_or_create_returns_same_instance_for_same_name(default_config):
    """Test CircuitBreaker.get_or_create returns same instance for same name."""
    cb1 = CircuitBreaker.get_or_create("svc", default_config)
    cb2 = CircuitBreaker.get_or_create("svc", CircuitBreakerConfig(failure_threshold=999))
    assert cb1 is cb2
    assert cb2.name == "svc"
    assert cb2.config is default_config


def test_circuit_breaker_state_open_transitions_to_half_open_when_timeout_elapsed(breaker):
    """Test CircuitBreaker.state auto-transitions OPEN -> HALF_OPEN when timeout has elapsed."""
    breaker.config.timeout_seconds = 30.0
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._state == CircuitState.OPEN
    opened_at = breaker._opened_at
    assert opened_at is not None

    with patch("src.circuit_breaker.time.time", return_value=opened_at + 30.0):
        assert breaker.state == CircuitState.HALF_OPEN
        assert breaker._state == CircuitState.HALF_OPEN


def test_circuit_breaker_should_attempt_reset_false_when_opened_at_none(breaker):
    """Test _should_attempt_reset returns False if _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_when_timeout_elapsed(breaker):
    """Test _should_attempt_reset returns True when timeout has elapsed since opened."""
    breaker.config.timeout_seconds = 10.0
    breaker._opened_at = 100.0
    with patch("src.circuit_breaker.time.time", return_value=110.0):
        assert breaker._should_attempt_reset() is True


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(breaker):
    """Test _transition_to(OPEN) records opened timestamp and increments state transitions."""
    with patch("src.circuit_breaker.time.time", return_value=123.456):
        breaker._transition_to(CircuitState.OPEN)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(123.456)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_half_open_calls_and_success_count(breaker):
    """Test _transition_to(HALF_OPEN) resets half-open call count and success_count."""
    breaker._half_open_calls = 2
    breaker._success_count = 99
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_closed_resets_counts_and_clears_sliding_window(breaker):
    """Test _transition_to(CLOSED) resets counters, clears sliding window, and clears opened_at."""
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
    assert list(breaker._sliding_window) == []
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_allow_request_closed_allows(breaker):
    """Test _allow_request returns True in CLOSED state."""
    breaker._state = CircuitState.CLOSED
    assert breaker._allow_request() is True


def test_circuit_breaker_allow_request_open_rejects(breaker):
    """Test _allow_request returns False in OPEN state (when not yet reset)."""
    breaker._state = CircuitState.OPEN
    breaker._opened_at = 100.0
    breaker.config.timeout_seconds = 30.0
    with patch("src.circuit_breaker.time.time", return_value=110.0):
        assert breaker._allow_request() is False


def test_circuit_breaker_allow_request_half_open_allows_up_to_max_calls(breaker):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls and then rejects."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker.config.half_open_max_calls = 2

    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 1
    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 2
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_returns_value(breaker):
    """Test execute returns operation result and records success metrics and response time."""
    with patch("src.circuit_breaker.time.time", side_effect=[100.0, 100.1, 100.2]):
        result = breaker.execute(lambda: "ok")
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.1)
    assert breaker.metrics.last_success_time == pytest.approx(100.2)


def test_circuit_breaker_execute_failure_records_metrics_and_reraises(breaker):
    """Test execute records failure metrics and re-raises the exception."""
    def op():
        raise ValueError("boom")

    with patch("src.circuit_breaker.time.time", side_effect=[200.0, 200.05, 200.2]):
        with pytest.raises(ValueError, match="boom"):
            breaker.execute(op)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.average_response_time == pytest.approx(0.05)
    assert breaker.metrics.last_failure_time == pytest.approx(200.2)


def test_circuit_breaker_execute_open_raises_and_increments_rejected_calls(breaker):
    """Test execute rejects requests when OPEN and raises CircuitBreakerOpenError with remaining time."""
    breaker.config.timeout_seconds = 30.0
    breaker._transition_to(CircuitState.OPEN)
    opened_at = breaker._opened_at
    assert opened_at is not None

    with patch("src.circuit_breaker.time.time", return_value=opened_at + 10.0):
        with pytest.raises(CircuitBreakerOpenError) as excinfo:
            breaker.execute(lambda: "nope")
    assert breaker.metrics.rejected_calls == 1
    assert excinfo.value.name == breaker.name
    assert excinfo.value.remaining_time == pytest.approx(20.0)


def test_circuit_breaker_execute_open_uses_fallback_and_increments_rejected_calls(breaker):
    """Test execute uses fallback when OPEN and does not raise."""
    breaker.config.timeout_seconds = 30.0
    breaker._transition_to(CircuitState.OPEN)
    opened_at = breaker._opened_at
    assert opened_at is not None

    with patch("src.circuit_breaker.time.time", return_value=opened_at + 5.0):
        result = breaker.execute(lambda: "primary", fallback=lambda: "fallback")
    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1
    assert breaker.metrics.total_calls == 0  # operation not invoked


def test_circuit_breaker_record_success_in_closed_decrements_failure_count_not_below_zero(breaker):
    """Test _record_success in CLOSED decrements failure count but never below zero."""
    breaker._state = CircuitState.CLOSED
    breaker._failure_count = 0
    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker._record_success(0.2)
    assert breaker._failure_count == 0

    breaker._failure_count = 2
    with patch("src.circuit_breaker.time.time", return_value=11.0):
        breaker._record_success(0.3)
    assert breaker._failure_count == 1
    assert breaker.metrics.successful_calls == 2
    assert breaker.metrics.average_response_time == pytest.approx((0.2 + 0.3) / 2)


def test_circuit_breaker_record_success_in_half_open_closes_after_success_threshold(breaker):
    """Test _record_success in HALF_OPEN transitions to CLOSED after success_threshold."""
    breaker.config.success_threshold = 2
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN

    with patch("src.circuit_breaker.time.time", return_value=20.0):
        breaker._record_success(0.1)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._success_count == 1

    with patch("src.circuit_breaker.time.time", return_value=21.0):
        breaker._record_success(0.1)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None


def test_circuit_breaker_record_failure_in_closed_opens_when_failure_threshold_reached(breaker):
    """Test _record_failure in CLOSED transitions to OPEN when failure_threshold is reached."""
    breaker.config.failure_threshold = 3
    breaker.config.sliding_window_size = 10  # keep failure_rate gating off until full window
    breaker._sliding_window = __import__("collections").deque(maxlen=breaker.config.sliding_window_size)

    with patch("src.circuit_breaker.time.time", side_effect=[1.0, 2.0, 3.0, 4.0]):
        breaker._record_failure(0.1)
        assert breaker._state == CircuitState.CLOSED
        breaker._record_failure(0.1)
        assert breaker._state == CircuitState.CLOSED
        breaker._record_failure(0.1)
        assert breaker._state == CircuitState.OPEN

    assert breaker._failure_count == 3
    assert breaker.metrics.failed_calls == 3
    assert breaker.metrics.state_transitions == 1
    assert breaker._opened_at == pytest.approx(4.0)


def test_circuit_breaker_record_failure_in_closed_opens_when_failure_rate_threshold_exceeded(breaker_small_window):
    """Test _record_failure in CLOSED transitions to OPEN when failure rate exceeds threshold once window is full."""
    cb = breaker_small_window
    cb.config.failure_rate_threshold = 0.5
    cb._state = CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 11.0, 12.0, 13.0]):
        cb._record_failure(0.01)  # window: F
        cb._record_failure(0.01)  # window: F F
        cb._record_failure(0.01)  # window: F F F
        cb._record_failure(0.01)  # window: F F F F => failure_rate=1.0 triggers OPEN

    assert cb._state == CircuitState.OPEN
    assert cb._calculate_failure_rate() == pytest.approx(1.0)


def test_circuit_breaker_calculate_failure_rate_returns_zero_until_window_full(breaker_small_window):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full."""
    cb = breaker_small_window
    cb._sliding_window.clear()
    cb._sliding_window.append(False)
    cb._sliding_window.append(True)
    cb._sliding_window.append(False)
    assert cb._calculate_failure_rate() == pytest.approx(0.0)  # len < window_size

    cb._sliding_window.append(True)  # now full size 4; failures=2 => 0.5
    assert cb._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker):
    """Test _record_failure in HALF_OPEN transitions immediately to OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN
    with patch("src.circuit_breaker.time.time", return_value=77.0):
        breaker._record_failure(0.12)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(77.0)


def test_circuit_breaker_get_health_info_structure_and_values(breaker_small_window):
    """Test get_health_info returns expected structure with state and metrics/config fields."""
    cb = breaker_small_window
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2
    cb._success_count = 1
    cb.metrics.total_calls = 7
    cb.metrics.successful_calls = 5
    cb.metrics.failed_calls = 2
    cb.metrics.rejected_calls = 3
    cb.metrics.state_transitions = 4
    cb.metrics.average_response_time = 0.123

    cb._sliding_window.clear()
    cb._sliding_window.extend([False, True, False, True])  # failure_rate=0.5

    info = cb.get_health_info()
    assert info["name"] == cb.name
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 2
    assert info["success_count"] == 1
    assert info["failure_rate"] == pytest.approx(0.5)

    assert info["metrics"]["total_calls"] == 7
    assert info["metrics"]["successful_calls"] == 5
    assert info["metrics"]["failed_calls"] == 2
    assert info["metrics"]["rejected_calls"] == 3
    assert info["metrics"]["state_transitions"] == 4
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(123.0)

    assert info["config"]["failure_threshold"] == cb.config.failure_threshold
    assert info["config"]["success_threshold"] == cb.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(cb.config.timeout_seconds)


def test_distributed_coordinator_init_defaults_node_id_from_env(monkeypatch):
    """Test coordinator uses NODE_ID environment variable when provided."""
    monkeypatch.setenv("NODE_ID", "node-xyz")
    coord = DistributedCircuitBreakerCoordinator("http://coord", sync_interval=1.0)
    assert coord.coordinator_url == "http://coord"
    assert coord.sync_interval == pytest.approx(1.0)
    assert coord.node_id == "node-xyz"
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None


def test_distributed_coordinator_init_defaults_node_id_generated_when_env_missing(monkeypatch):
    """Test coordinator generates node_id with python-<pid> when NODE_ID missing."""
    monkeypatch.delenv("NODE_ID", raising=False)
    with patch("src.circuit_breaker.os.getpid", return_value=4321):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
    assert coord.node_id == "python-4321"


def test_distributed_coordinator_register_breaker_stores_and_sends_registration(coordinator, breaker):
    """Test register_breaker stores breaker and calls _send_registration."""
    coordinator._send_registration = Mock()
    coordinator.register_breaker(breaker)
    assert coordinator._breakers[breaker.name] is breaker
    coordinator._send_registration.assert_called_once_with(breaker)


def test_distributed_coordinator_send_registration_posts_json_request(coordinator, breaker):
    """Test _send_registration sends correct POST to registration endpoint."""
    coordinator.node_id = "node-1"

    def fake_urlopen(req, timeout):
        assert timeout == 5
        assert isinstance(req, urllib.request.Request)
        assert req.full_url == "http://coordinator/circuit-breakers/register"
        assert req.method == "POST"
        assert req.headers["Content-type"] == "application/json"
        body = req.data
        payload = json.loads(body.decode("utf-8"))
        assert payload["service"] == breaker.name
        assert payload["node_id"] == "node-1"
        assert payload["failure_threshold"] == breaker.config.failure_threshold
        assert payload["success_threshold"] == breaker.config.success_threshold
        return Mock()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as m:
        coordinator._send_registration(breaker)
        assert m.call_count == 1


def test_distributed_coordinator_send_registration_swallows_urlerror(coordinator, breaker):
    """Test _send_registration ignores URLError exceptions."""
    with patch(
        "src.circuit_breaker.urllib.request.urlopen",
        side_effect=urllib.error.URLError("down"),
    ):
        coordinator._send_registration(breaker)  # should not raise


def test_distributed_coordinator_start_sync_creates_and_starts_thread(coordinator):
    """Test start_sync sets running and starts a daemon sync thread."""
    thread_mock = Mock()
    thread_mock.start = Mock()

    def fake_thread(*args, **kwargs):
        assert kwargs.get("daemon") is True
        assert kwargs.get("target") == coordinator._sync_loop
        return thread_mock

    with patch("src.circuit_breaker.threading.Thread", side_effect=fake_thread) as m:
        coordinator.start_sync()
        assert coordinator._running is True
        assert coordinator._sync_thread is thread_mock
        thread_mock.start.assert_called_once()
        assert m.call_count == 1


def test_distributed_coordinator_stop_sync_joins_thread(coordinator):
    """Test stop_sync sets running False and joins existing sync thread."""
    coordinator._running = True
    coordinator._sync_thread = Mock()
    coordinator.stop_sync()
    assert coordinator._running is False
    coordinator._sync_thread.join.assert_called_once()
    _, kwargs = coordinator._sync_thread.join.call_args
    assert kwargs["timeout"] == 2


def test_distributed_coordinator_sync_loop_calls_synchronize_and_sleeps_until_stopped(coordinator):
    """Test _sync_loop calls _synchronize_states and sleeps; exceptions inside are swallowed."""
    call_count = {"sync": 0, "sleep": 0}

    def fake_sync():
        call_count["sync"] += 1
        if call_count["sync"] == 1:
            raise RuntimeError("boom")

    def fake_sleep(_):
        call_count["sleep"] += 1
        coordinator._running = False

    coordinator._running = True
    coordinator._synchronize_states = Mock(side_effect=fake_sync)

    with patch("src.circuit_breaker.time.sleep", side_effect=fake_sleep):
        coordinator._sync_loop()

    assert call_count["sync"] == 2
    assert call_count["sleep"] == 2


def test_distributed_coordinator_synchronize_states_posts_state_for_each_breaker(coordinator, breaker):
    """Test _synchronize_states posts state for all registered breakers with expected payload."""
    coordinator._breakers = {breaker.name: breaker}
    coordinator.node_id = "node-2"
    breaker._failure_count = 3

    breaker.get_health_info = Mock(return_value={"ok": True})
    breaker._state = CircuitState.CLOSED

    with patch("src.circuit_breaker.time.time", return_value=1000.0):

        def fake_urlopen(req, timeout):
            assert timeout == 5
            assert req.full_url == "http://coordinator/circuit-breakers/state"
            assert req.method == "POST"
            payload = json.loads(req.data.decode("utf-8"))
            assert payload["service"] == breaker.name
            assert payload["node_id"] == "node-2"
            assert payload["state"] == "CLOSED"
            assert payload["failure_count"] == 3
            assert payload["timestamp"] == 1000000
            assert payload["health_info"] == {"ok": True}
            return Mock()

        with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as m:
            coordinator._synchronize_states()
            assert m.call_count == 1
            breaker.get_health_info.assert_called_once_with()


def test_distributed_coordinator_synchronize_states_swallows_urlerror(coordinator, breaker):
    """Test _synchronize_states ignores URLError and continues."""
    coordinator._breakers = {breaker.name: breaker}

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._synchronize_states()  # should not raise


def test_distributed_coordinator_get_cluster_state_success(coordinator):
    """Test get_cluster_state returns decoded JSON response on success."""
    resp = Mock()
    resp.read.return_value = b'{"state":"ok","nodes":2}'

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=resp) as m:
        result = coordinator.get_cluster_state("svcA")

    assert m.call_count == 1
    req = m.call_args.args[0]
    assert isinstance(req, urllib.request.Request)
    assert req.full_url == "http://coordinator/circuit-breakers/svcA/aggregate"
    assert req.method == "GET"
    assert result == {"state": "ok", "nodes": 2}


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        result = coordinator.get_cluster_state("svcA")
    assert result == {"error": "Failed to fetch cluster state"}


def test_decorator_circuit_breaker_wraps_function_and_exposes_breaker(reset_circuit_breaker_registry):
    """Test circuit_breaker decorator uses shared breaker and sets __wrapped__ and circuit_breaker attributes."""
    cfg = CircuitBreakerConfig(failure_threshold=2, timeout_seconds=1.0)

    @circuit_breaker("decor-svc", cfg)
    def add(a, b):
        return a + b

    assert add.__wrapped__.__name__ == "add"
    assert isinstance(add.circuit_breaker, CircuitBreaker)
    assert add.circuit_breaker.name == "decor-svc"

    assert add(2, 3) == 5
    assert add.circuit_breaker.metrics.total_calls == 1
    assert add.circuit_breaker.metrics.successful_calls == 1