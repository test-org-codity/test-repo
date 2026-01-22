import time
import threading
import json
import os
from collections import deque
from unittest.mock import Mock, patch, call

import pytest

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
    """Reset CircuitBreaker registry before each test to avoid cross-test contamination."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig instance."""
    return CircuitBreakerConfig()


@pytest.fixture
def circuit_breaker_instance(default_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test_service", config=default_config)


@pytest.fixture
def coordinator_instance(tmp_path):
    """Create a DistributedCircuitBreakerCoordinator instance for testing."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator.test", sync_interval=0.01)


def test_circuit_state_enum_values():
    """Test CircuitState enum has expected values."""
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


def test_circuit_breaker_metrics_initialization():
    """Test CircuitBreakerMetrics initializes with correct default values."""
    metrics = CircuitBreakerMetrics()
    assert metrics.total_calls == 0
    assert metrics.successful_calls == 0
    assert metrics.failed_calls == 0
    assert metrics.rejected_calls == 0
    assert metrics.state_transitions == 0
    assert metrics.last_failure_time is None
    assert metrics.last_success_time is None
    assert metrics.average_response_time == pytest.approx(0.0)
    assert isinstance(metrics._response_times, deque)
    assert metrics._response_times.maxlen == 100


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test record_response_time updates internal deque and average_response_time."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert len(metrics._response_times) == 2
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3) / 2)


def test_circuit_breaker_open_error_message_and_attributes():
    """Test CircuitBreakerOpenError stores name and remaining_time and formats message."""
    err = CircuitBreakerOpenError("svc", 12.3456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)
    assert "12.35" in str(err)


def test_circuit_breaker_initialization_defaults(default_config):
    """Test CircuitBreaker initialization sets default internal state."""
    cb = CircuitBreaker("svc", default_config)
    assert cb.name == "svc"
    assert cb.config is default_config
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._half_open_calls == 0
    assert cb._opened_at is None
    assert isinstance(cb._state_lock, threading.RLock)
    assert isinstance(cb._sliding_window, deque)
    assert cb._sliding_window.maxlen == default_config.sliding_window_size
    assert isinstance(cb.metrics, CircuitBreakerMetrics)


def test_circuit_breaker_get_or_create_creates_and_reuses_instance(default_config):
    """Test get_or_create creates a new instance and reuses it on subsequent calls."""
    cb1 = CircuitBreaker.get_or_create("svc", default_config)
    cb2 = CircuitBreaker.get_or_create("svc", default_config)
    cb3 = CircuitBreaker.get_or_create("other", default_config)
    assert cb1 is cb2
    assert cb1 is not cb3
    assert CircuitBreaker._registry["svc"] is cb1
    assert CircuitBreaker._registry["other"] is cb3


def test_circuit_breaker_state_auto_transitions_from_open_to_half_open_on_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN when timeout has elapsed."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + cb.config.timeout_seconds + 0.1

    monkeypatch.setattr(time, "time", lambda: fake_time())
    assert cb.state == CircuitState.HALF_OPEN
    assert cb._state == CircuitState.HALF_OPEN


def test_circuit_breaker_state_stays_open_before_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property remains OPEN if timeout has not elapsed."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + cb.config.timeout_seconds - 0.1

    monkeypatch.setattr(time, "time", lambda: fake_time())
    assert cb.state == CircuitState.OPEN
    assert cb._state == CircuitState.OPEN


def test_circuit_breaker_should_attempt_reset_logic(circuit_breaker_instance, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout and when opened_at is set."""
    cb = circuit_breaker_instance
    assert cb._should_attempt_reset() is False

    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    monkeypatch.setattr(time, "time", lambda: opened_at + cb.config.timeout_seconds - 0.01)
    assert cb._should_attempt_reset() is False

    monkeypatch.setattr(time, "time", lambda: opened_at + cb.config.timeout_seconds + 0.01)
    assert cb._should_attempt_reset() is True


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(circuit_breaker_instance):
    """Test _transition_to OPEN sets opened_at and increments state_transitions."""
    cb = circuit_breaker_instance
    before = cb.metrics.state_transitions
    cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb._opened_at is not None
    assert cb.metrics.state_transitions == before + 1


def test_circuit_breaker_transition_to_half_open_resets_counters(circuit_breaker_instance):
    """Test _transition_to HALF_OPEN resets half_open_calls and success_count."""
    cb = circuit_breaker_instance
    cb._half_open_calls = 5
    cb._success_count = 7
    cb._transition_to(CircuitState.HALF_OPEN)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._half_open_calls == 0
    assert cb._success_count == 0


def test_circuit_breaker_transition_to_closed_resets_failure_success_and_window(circuit_breaker_instance):
    """Test _transition_to CLOSED resets failure_count, success_count, opened_at, and sliding window."""
    cb = circuit_breaker_instance
    cb._failure_count = 10
    cb._success_count = 5
    cb._opened_at = time.time()
    cb._sliding_window.extend([True, False])
    cb._transition_to(CircuitState.CLOSED)
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0


def test_circuit_breaker_allow_request_closed_state_allows(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    assert cb._allow_request() is True


def test_circuit_breaker_allow_request_open_state_rejects(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    assert cb._allow_request() is False


def test_circuit_breaker_allow_request_half_open_respects_max_calls(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls then rejects."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.half_open_max_calls = 2
    assert cb._allow_request() is True
    assert cb._half_open_calls == 1
    assert cb._allow_request() is True
    assert cb._half_open_calls == 2
    assert cb._allow_request() is False
    assert cb._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_returns_result(circuit_breaker_instance, monkeypatch):
    """Test execute on successful operation updates metrics and returns result."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED

    def fake_time():
        return 1000.0

    times = [1000.0, 1000.1]
    monkeypatch.setattr(time, "time", lambda: times.pop(0))

    op = Mock(return_value="ok")
    result = cb.execute(op)

    assert result == "ok"
    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.failed_calls == 0
    assert len(cb.metrics._response_times) == 1
    assert cb.metrics.average_response_time == pytest.approx(0.1)


def test_circuit_breaker_execute_failure_records_metrics_and_raises(circuit_breaker_instance, monkeypatch):
    """Test execute on failing operation updates metrics and re-raises exception."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED

    times = [1000.0, 1000.2]
    monkeypatch.setattr(time, "time", lambda: times.pop(0))

    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        cb.execute(failing)

    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.successful_calls == 0
    assert len(cb.metrics._response_times) == 1
    assert cb.metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_execute_open_state_uses_fallback_and_increments_rejected(circuit_breaker_instance):
    """Test execute when breaker is OPEN uses fallback and increments rejected_calls."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._opened_at = time.time()
    fallback = Mock(return_value="fallback")

    result = cb.execute(operation=Mock(), fallback=fallback)

    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    fallback.assert_called_once()


def test_circuit_breaker_execute_open_state_raises_open_error_without_fallback(circuit_breaker_instance, monkeypatch):
    """Test execute when breaker is OPEN raises CircuitBreakerOpenError without fallback."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    opened_at = time.time()
    cb._opened_at = opened_at

    monkeypatch.setattr(time, "time", lambda: opened_at + 5.0)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(operation=Mock())

    err = exc.value
    remaining = cb.config.timeout_seconds - 5.0
    assert err.name == cb.name
    assert err.remaining_time == pytest.approx(max(0, remaining))


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(circuit_breaker_instance, monkeypatch):
    """Test _record_success in HALF_OPEN increments success_count and transitions to CLOSED at threshold."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.success_threshold = 2
    cb._success_count = 1

    monkeypatch.setattr(time, "time", lambda: 1000.0)
    cb._record_success(duration=0.05)

    assert cb._state == CircuitState.CLOSED
    assert cb._success_count == 0
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.last_success_time == pytest.approx(1000.0)
    assert cb.metrics.average_response_time == pytest.approx(0.05)


def test_circuit_breaker_record_success_in_closed_decrements_failure_count(circuit_breaker_instance, monkeypatch):
    """Test _record_success in CLOSED decrements failure_count but not below zero."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2

    monkeypatch.setattr(time, "time", lambda: 1000.0)
    cb._record_success(duration=0.1)
    assert cb._failure_count == 1

    cb._record_success(duration=0.1)
    assert cb._failure_count == 0

    cb._record_success(duration=0.1)
    assert cb._failure_count == 0


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(circuit_breaker_instance, monkeypatch):
    """Test _record_failure in HALF_OPEN transitions breaker back to OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN

    monkeypatch.setattr(time, "time", lambda: 1000.0)
    cb._record_failure(duration=0.2)

    assert cb._state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.last_failure_time == pytest.approx(1000.0)
    assert cb.metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_record_failure_in_closed_opens_on_threshold(circuit_breaker_instance, monkeypatch):
    """Test _record_failure in CLOSED opens breaker when failure_threshold reached."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb.config.failure_threshold = 3

    monkeypatch.setattr(time, "time", lambda: 1000.0)
    for _ in range(2):
        cb._record_failure(duration=0.1)
        assert cb._state == CircuitState.CLOSED

    cb._record_failure(duration=0.1)
    assert cb._state == CircuitState.OPEN
    assert cb._failure_count == 3


def test_circuit_breaker_calculate_failure_rate_requires_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 4
    cb._sliding_window = deque(maxlen=4)

    cb._sliding_window.extend([True, False])
    assert cb._calculate_failure_rate() == pytest.approx(0.0)

    cb._sliding_window.extend([False, False])
    assert len(cb._sliding_window) == 4
    assert cb._calculate_failure_rate() == pytest.approx(3 / 4)


def test_circuit_breaker_get_health_info_structure_and_values(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2
    cb._success_count = 5
    cb.metrics.total_calls = 10
    cb.metrics.successful_calls = 7
    cb.metrics.failed_calls = 3
    cb.metrics.rejected_calls = 1
    cb.metrics.average_response_time = 0.123
    cb.metrics.state_transitions = 4
    cb.config.failure_threshold = 9
    cb.config.success_threshold = 8
    cb.config.timeout_seconds = 15.0
    cb._sliding_window = deque([True] * cb.config.sliding_window_size, maxlen=cb.config.sliding_window_size)

    info = cb.get_health_info()
    assert info["name"] == cb.name
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 2
    assert info["success_count"] == 5
    assert info["failure_rate"] == pytest.approx(0.0)
    assert info["metrics"]["total_calls"] == 10
    assert info["metrics"]["successful_calls"] == 7
    assert info["metrics"]["failed_calls"] == 3
    assert info["metrics"]["rejected_calls"] == 1
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(0.123 * 1000)
    assert info["metrics"]["state_transitions"] == 4
    assert info["config"]["failure_threshold"] == 9
    assert info["config"]["success_threshold"] == 8
    assert info["config"]["timeout_seconds"] == pytest.approx(15.0)


def test_distributed_coordinator_initialization_uses_env_node_id(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator initialization uses NODE_ID env or fallback."""
    monkeypatch.setenv("NODE_ID", "node-123")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test")
    assert coord.coordinator_url == "http://coordinator.test"
    assert coord.sync_interval == pytest.approx(5.0)
    assert coord.node_id == "node-123"
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None


def test_distributed_coordinator_initialization_fallback_node_id(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator uses fallback node_id when NODE_ID not set."""
    monkeypatch.delenv("NODE_ID", raising=False)
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test")
    assert coord.node_id.startswith("python-")
    assert isinstance(int(coord.node_id.split("-")[1]), int)


def test_distributed_coordinator_register_breaker_stores_and_sends_registration(coordinator_instance, circuit_breaker_instance):
    """Test register_breaker stores breaker and calls _send_registration."""
    coord = coordinator_instance
    with patch.object(coord, "_send_registration") as mock_send:
        coord.register_breaker(circuit_breaker_instance)
        assert coord._breakers["test_service"] is circuit_breaker_instance
        mock_send.assert_called_once_with(circuit_breaker_instance)


def test_distributed_coordinator_send_registration_success(monkeypatch, coordinator_instance, circuit_breaker_instance):
    """Test _send_registration sends correct HTTP request and ignores success response."""
    coord = coordinator_instance
    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)

    coord._send_registration(circuit_breaker_instance)

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == f"{coord.coordinator_url}/circuit-breakers/register"
    assert req.get_method() == "POST"
    assert req.headers["Content-Type"] == "application/json"
    body = json.loads(req.data.decode("utf-8"))
    assert body["service"] == circuit_breaker_instance.name
    assert body["node_id"] == coord.node_id
    assert body["failure_threshold"] == circuit_breaker_instance.config.failure_threshold
    assert body["success_threshold"] == circuit_breaker_instance.config.success_threshold


def test_distributed_coordinator_send_registration_handles_url_error(monkeypatch, coordinator_instance, circuit_breaker_instance):
    """Test _send_registration silently ignores URLError."""
    coord = coordinator_instance
    def raise_url_error(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_url_error)
    coord._send_registration(circuit_breaker_instance)  # should not raise


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance, monkeypatch):
    """Test start_sync starts a daemon thread and stop_sync stops it."""
    coord = coordinator_instance

    with patch.object(coord, "_sync_loop") as mock_loop:
        coord.start_sync()
        assert coord._running is True
        assert coord._sync_thread is not None
        assert coord._sync_thread.daemon is True

        coord.stop_sync()
        assert coord._running is False
        mock_loop.assert_called()


def test_distributed_coordinator_sync_loop_calls_synchronize_states_and_sleeps(coordinator_instance, monkeypatch):
    """Test _sync_loop repeatedly calls _synchronize_states and sleeps while running."""
    coord = coordinator_instance
    calls = []

    def fake_sleep(interval):
        calls.append(("sleep", interval))
        coord._running = False

    monkeypatch.setattr(time, "sleep", fake_sleep)
    with patch.object(coord, "_synchronize_states") as mock_sync:
        coord._running = True
        coord._sync_loop()
        mock_sync.assert_called_once()
        assert calls == [("sleep", coord.sync_interval)]


def test_distributed_coordinator_sync_loop_handles_exceptions(coordinator_instance, monkeypatch):
    """Test _sync_loop catches exceptions from _synchronize_states and continues."""
    coord = coordinator_instance
    calls = []

    def fake_sleep(interval):
        calls.append(("sleep", interval))
        coord._running = False

    monkeypatch.setattr(time, "sleep", fake_sleep)

    def raise_once():
        if not calls:
            raise RuntimeError("fail")

    with patch.object(coord, "_synchronize_states", side_effect=raise_once) as mock_sync:
        coord._running = True
        coord._sync_loop()
        assert mock_sync.call_count == 2
        assert calls == [("sleep", coord.sync_interval)]


def test_distributed_coordinator_synchronize_states_posts_state_for_each_breaker(coordinator_instance, circuit_breaker_instance, monkeypatch):
    """Test _synchronize_states posts state for each registered breaker."""
    coord = coordinator_instance
    coord._breakers["test_service"] = circuit_breaker_instance

    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)
    monkeypatch.setattr(time, "time", lambda: 1000.0)

    coord._synchronize_states()

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == f"{coord.coordinator_url}/circuit-breakers/state"
    assert req.get_method() == "POST"
    assert req.headers["Content-Type"] == "application/json"
    body = json.loads(req.data.decode("utf-8"))
    assert body["service"] == "test_service"
    assert body["node_id"] == coord.node_id
    assert body["state"] == circuit_breaker_instance.state.value
    assert body["failure_count"] == circuit_breaker_instance._failure_count
    assert body["timestamp"] == 1000 * 1000
    assert "health_info" in body


def test_distributed_coordinator_synchronize_states_handles_url_error(coordinator_instance, circuit_breaker_instance, monkeypatch):
    """Test _synchronize_states ignores URLError for each breaker."""
    coord = coordinator_instance
    coord._breakers["test_service"] = circuit_breaker_instance

    def raise_url_error(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_url_error)
    coord._synchronize_states()  # should not raise


def test_distributed_coordinator_get_cluster_state_success(monkeypatch, coordinator_instance):
    """Test get_cluster_state returns parsed JSON from coordinator on success."""
    coord = coordinator_instance
    response_data = {"state": "ok"}

    class FakeResponse:
        def read(self):
            return json.dumps(response_data).encode("utf-8")

    mock_urlopen = Mock(return_value=FakeResponse())
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)

    result = coord.get_cluster_state("svc")
    assert result == response_data
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == f"{coord.coordinator_url}/circuit-breakers/svc/aggregate"
    assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_handles_url_error(monkeypatch, coordinator_instance):
    """Test get_cluster_state returns error dict when URLError occurs."""
    coord = coordinator_instance

    def raise_url_error(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_url_error)
    result = coord.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker(monkeypatch):
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    cb = CircuitBreaker.get_or_create("decorated")

    with patch.object(cb, "execute", return_value="wrapped") as mock_execute:
        @circuit_breaker("decorated")
        def my_func(x, y):
            return x + y

        result = my_func(1, 2)
        assert result == "wrapped"
        assert my_func.__wrapped__(1, 2) == 3
        assert my_func.circuit_breaker is cb
        mock_execute.assert_called_once()
        op = mock_execute.call_args[0][0]
        assert op() == 3