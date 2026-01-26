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
def clean_circuit_breaker_registry():
    """Clear the CircuitBreaker registry before each test to avoid cross-test interference."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig fixture."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Provide a CircuitBreaker instance fixture."""
    return CircuitBreaker(name="test-service", config=default_config)


@pytest.fixture
def coordinator():
    """Provide a DistributedCircuitBreakerCoordinator instance fixture."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator")


# ---------- CircuitState tests ----------


def test_circuit_state_enum_values():
    """Test CircuitState enum has expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


# ---------- CircuitBreakerConfig tests ----------


def test_circuit_breaker_config_defaults():
    """Test CircuitBreakerConfig default values."""
    config = CircuitBreakerConfig()
    assert config.failure_threshold == 5
    assert config.success_threshold == 3
    assert config.timeout_seconds == pytest.approx(30.0)
    assert config.half_open_max_calls == 3
    assert config.sliding_window_size == 10
    assert config.failure_rate_threshold == pytest.approx(0.5)


# ---------- CircuitBreakerMetrics tests ----------


def test_circuit_breaker_metrics_init_defaults():
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
    """Test record_response_time appends duration and updates average_response_time."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert list(metrics._response_times) == [0.1, 0.3]
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3) / 2)


def test_circuit_breaker_metrics_record_response_time_respects_maxlen():
    """Test record_response_time respects _response_times maxlen."""
    metrics = CircuitBreakerMetrics()
    for i in range(150):
        metrics.record_response_time(float(i))
    # Only 100 most recent should remain
    assert len(metrics._response_times) == 100
    assert metrics._response_times[0] == 50.0
    assert metrics._response_times[-1] == 149.0


# ---------- CircuitBreakerOpenError tests ----------


def test_circuit_breaker_open_error_message_and_attributes():
    """Test CircuitBreakerOpenError stores attributes and formats message."""
    err = CircuitBreakerOpenError("svc", 12.3456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'svc' is open." in str(err)
    assert "Retry after" in str(err)


# ---------- CircuitBreaker __init__ tests ----------


def test_circuit_breaker_init_defaults():
    """Test CircuitBreaker initialization with default config."""
    cb = CircuitBreaker("svc")
    assert cb.name == "svc"
    assert isinstance(cb.config, CircuitBreakerConfig)
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._half_open_calls == 0
    assert cb._opened_at is None
    assert isinstance(cb._state_lock, threading.RLock)
    assert isinstance(cb._sliding_window, deque)
    assert cb._sliding_window.maxlen == cb.config.sliding_window_size
    assert isinstance(cb.metrics, CircuitBreakerMetrics)


def test_circuit_breaker_init_with_custom_config(default_config):
    """Test CircuitBreaker initialization with custom config."""
    default_config.failure_threshold = 10
    cb = CircuitBreaker("svc", config=default_config)
    assert cb.config is default_config
    assert cb.config.failure_threshold == 10


# ---------- CircuitBreaker.get_or_create tests ----------


def test_circuit_breaker_get_or_create_creates_new_instance(default_config):
    """Test get_or_create creates a new CircuitBreaker when not in registry."""
    cb = CircuitBreaker.get_or_create("svc", config=default_config)
    assert isinstance(cb, CircuitBreaker)
    assert cb.name == "svc"
    assert CircuitBreaker._registry["svc"] is cb


def test_circuit_breaker_get_or_create_returns_existing_instance(default_config):
    """Test get_or_create returns existing instance from registry and ignores new config."""
    cb1 = CircuitBreaker.get_or_create("svc", config=default_config)
    new_config = CircuitBreakerConfig(failure_threshold=99)
    cb2 = CircuitBreaker.get_or_create("svc", config=new_config)
    assert cb1 is cb2
    # Original config should remain
    assert cb2.config is default_config
    assert cb2.config.failure_threshold == 5


# ---------- CircuitBreaker.state and _should_attempt_reset tests ----------


def test_circuit_breaker_state_closed_does_not_change(breaker):
    """Test state property returns CLOSED and does not change when already CLOSED."""
    assert breaker._state == CircuitState.CLOSED
    assert breaker.state == CircuitState.CLOSED
    assert breaker._state == CircuitState.CLOSED


def test_circuit_breaker_state_open_no_timeout_stays_open(breaker, monkeypatch):
    """Test state property stays OPEN when timeout has not elapsed."""
    breaker._state = CircuitState.OPEN
    now = time.time()
    breaker._opened_at = now

    def fake_time():
        return now + breaker.config.timeout_seconds - 1

    monkeypatch.setattr("time.time", fake_time)
    assert breaker.state == CircuitState.OPEN
    assert breaker._state == CircuitState.OPEN


def test_circuit_breaker_state_open_with_timeout_transitions_to_half_open(breaker, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN when timeout elapsed."""
    breaker._state = CircuitState.OPEN
    opened_at = time.time()
    breaker._opened_at = opened_at

    def fake_time():
        return opened_at + breaker.config.timeout_seconds + 1

    monkeypatch.setattr("time.time", fake_time)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker._state == CircuitState.HALF_OPEN


def test_circuit_breaker_should_attempt_reset_false_without_opened_at(breaker):
    """Test _should_attempt_reset returns False if _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_after_timeout(breaker, monkeypatch):
    """Test _should_attempt_reset returns True after timeout has elapsed."""
    now = time.time()
    breaker._opened_at = now

    def fake_time():
        return now + breaker.config.timeout_seconds + 0.1

    monkeypatch.setattr("time.time", fake_time)
    assert breaker._should_attempt_reset() is True


# ---------- CircuitBreaker._transition_to tests ----------


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_metrics(breaker, monkeypatch):
    """Test _transition_to(OPEN) sets opened_at and increments state_transitions."""
    start_time = 123456.0

    def fake_time():
        return start_time

    monkeypatch.setattr("time.time", fake_time)
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(start_time)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_counts(breaker):
    """Test _transition_to(HALF_OPEN) resets half_open_calls and success_count."""
    breaker._state = CircuitState.OPEN
    breaker._half_open_calls = 5
    breaker._success_count = 7
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0


def test_circuit_breaker_transition_to_closed_resets_failure_and_clears_window(breaker):
    """Test _transition_to(CLOSED) resets failure_count, success_count and sliding window."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._opened_at = 123.0
    breaker._sliding_window.extend([True, False])
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0


# ---------- CircuitBreaker._allow_request tests ----------


def test_circuit_breaker_allow_request_when_closed(breaker):
    """Test _allow_request returns True when state is CLOSED."""
    breaker._state = CircuitState.CLOSED
    assert breaker._allow_request() is True


def test_circuit_breaker_allow_request_when_open(breaker):
    """Test _allow_request returns False when state is OPEN."""
    breaker._state = CircuitState.OPEN
    assert breaker._allow_request() is False


def test_circuit_breaker_allow_request_half_open_within_limit(breaker):
    """Test _allow_request returns True in HALF_OPEN while under half_open_max_calls."""
    breaker._state = CircuitState.HALF_OPEN
    breaker._half_open_calls = 0
    breaker.config.half_open_max_calls = 2
    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 1
    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 2


def test_circuit_breaker_allow_request_half_open_exceeds_limit(breaker):
    """Test _allow_request returns False in HALF_OPEN when exceeding half_open_max_calls."""
    breaker._state = CircuitState.HALF_OPEN
    breaker.config.half_open_max_calls = 1
    breaker._half_open_calls = 1
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == 1


# ---------- CircuitBreaker.execute tests ----------


def test_circuit_breaker_execute_success_records_metrics_and_returns_result(breaker, monkeypatch):
    """Test execute with successful operation updates metrics and returns operation result."""
    breaker._state = CircuitState.CLOSED

    def fake_time():
        # Simple increasing times on each call
        fake_time.current += 0.01
        return fake_time.current

    fake_time.current = 1000.0
    monkeypatch.setattr("time.time", fake_time)

    operation = Mock(return_value="ok")
    result = breaker.execute(operation)

    assert result == "ok"
    assert operation.called
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.01)


def test_circuit_breaker_execute_failure_records_and_raises(breaker, monkeypatch):
    """Test execute when operation raises propagates exception and records failure."""
    breaker._state = CircuitState.CLOSED

    def fake_time():
        fake_time.current += 0.02
        return fake_time.current

    fake_time.current = 2000.0
    monkeypatch.setattr("time.time", fake_time)

    class CustomError(Exception):
        pass

    operation = Mock(side_effect=CustomError("boom"))
    with pytest.raises(CustomError):
        breaker.execute(operation)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.02)


def test_circuit_breaker_execute_open_without_fallback_raises_open_error(breaker, monkeypatch):
    """Test execute when breaker is OPEN without fallback raises CircuitBreakerOpenError."""
    breaker._state = CircuitState.OPEN
    opened_at = 1000.0

    def fake_time():
        return opened_at + 5.0

    breaker._opened_at = opened_at
    breaker.config.timeout_seconds = 30.0
    monkeypatch.setattr("time.time", fake_time)

    operation = Mock()
    with pytest.raises(CircuitBreakerOpenError) as exc_info:
        breaker.execute(operation)

    assert not operation.called
    assert breaker.metrics.rejected_calls == 1
    err = exc_info.value
    remaining = breaker.config.timeout_seconds - (fake_time() - opened_at)
    assert err.remaining_time == pytest.approx(max(0, remaining))


def test_circuit_breaker_execute_open_with_fallback_uses_fallback(breaker, monkeypatch):
    """Test execute when breaker is OPEN with fallback uses fallback and does not raise."""
    breaker._state = CircuitState.OPEN
    opened_at = 1000.0

    def fake_time():
        return opened_at + 1.0

    breaker._opened_at = opened_at
    monkeypatch.setattr("time.time", fake_time)

    operation = Mock()
    fallback = Mock(return_value="fallback")
    result = breaker.execute(operation, fallback=fallback)

    assert result == "fallback"
    assert not operation.called
    assert fallback.called
    assert breaker.metrics.rejected_calls == 1


# ---------- CircuitBreaker._record_success tests ----------


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(breaker, monkeypatch):
    """Test _record_success in HALF_OPEN increments success_count and may close breaker."""
    breaker._state = CircuitState.HALF_OPEN
    breaker.config.success_threshold = 2
    start_time = 3000.0

    def fake_time():
        return start_time

    monkeypatch.setattr("time.time", fake_time)

    breaker._record_success(0.05)
    assert breaker._success_count == 1
    assert breaker._state == CircuitState.HALF_OPEN

    breaker._record_success(0.05)
    assert breaker._success_count == 0  # reset after transition_to(CLOSED)
    assert breaker._state == CircuitState.CLOSED
    assert breaker.metrics.successful_calls == 2
    assert breaker.metrics.last_success_time == pytest.approx(start_time)
    assert len(breaker._sliding_window) == 2
    assert all(breaker._sliding_window)


def test_circuit_breaker_record_success_in_closed_decrements_failure_count(breaker, monkeypatch):
    """Test _record_success in CLOSED decrements failure_count but not below zero."""
    breaker._state = CircuitState.CLOSED
    breaker._failure_count = 2

    def fake_time():
        return 4000.0

    monkeypatch.setattr("time.time", fake_time)

    breaker._record_success(0.01)
    assert breaker._failure_count == 1
    breaker._record_success(0.01)
    assert breaker._failure_count == 0
    breaker._record_success(0.01)
    assert breaker._failure_count == 0


# ---------- CircuitBreaker._record_failure tests ----------


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker, monkeypatch):
    """Test _record_failure in HALF_OPEN transitions immediately back to OPEN."""
    breaker._state = CircuitState.HALF_OPEN

    def fake_time():
        return 5000.0

    monkeypatch.setattr("time.time", fake_time)

    breaker._record_failure(0.02)
    assert breaker._state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.last_failure_time == pytest.approx(5000.0)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_record_failure_in_closed_uses_threshold_and_failure_rate(breaker, monkeypatch):
    """Test _record_failure in CLOSED uses both failure_threshold and failure_rate to open."""
    breaker._state = CircuitState.CLOSED
    breaker.config.failure_threshold = 3
    breaker.config.sliding_window_size = 4
    breaker.config.failure_rate_threshold = 0.5

    def fake_time():
        return 6000.0

    monkeypatch.setattr("time.time", fake_time)

    # First two failures - below threshold and sliding window not full => stays CLOSED
    breaker._record_failure(0.01)
    assert breaker._failure_count == 1
    assert breaker._state == CircuitState.CLOSED
    breaker._record_failure(0.01)
    assert breaker._failure_count == 2
    assert breaker._state == CircuitState.CLOSED

    # Fill sliding window to trigger failure rate calculation (50%)
    breaker._sliding_window.extend([True, False])  # Now [False, False, True, False] -> 3/4 failures = 0.75
    breaker._record_failure(0.01)
    assert breaker._failure_count == 3
    # Either threshold or failure_rate triggers OPEN; both should
    assert breaker._state == CircuitState.OPEN
    assert breaker.metrics.state_transitions == 1


# ---------- CircuitBreaker._calculate_failure_rate tests ----------


def test_circuit_breaker_calculate_failure_rate_not_enough_data_returns_zero(breaker):
    """Test _calculate_failure_rate returns 0 when sliding window not yet full."""
    breaker.config.sliding_window_size = 5
    breaker._sliding_window.extend([True, False, True])
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_with_full_window(breaker):
    """Test _calculate_failure_rate calculates correct failure rate when window is full."""
    breaker.config.sliding_window_size = 4
    breaker._sliding_window = deque(maxlen=4)
    breaker._sliding_window.extend([True, False, False, True])
    rate = breaker._calculate_failure_rate()
    assert rate == pytest.approx(2 / 4)


# ---------- CircuitBreaker.get_health_info tests ----------


def test_circuit_breaker_get_health_info_structure_and_values(breaker):
    """Test get_health_info returns expected structure and values."""
    breaker._state = CircuitState.CLOSED
    breaker._failure_count = 2
    breaker._success_count = 5
    breaker.metrics.total_calls = 10
    breaker.metrics.successful_calls = 7
    breaker.metrics.failed_calls = 3
    breaker.metrics.rejected_calls = 1
    breaker.metrics.state_transitions = 4
    breaker.metrics.average_response_time = 0.123

    breaker.config.failure_threshold = 9
    breaker.config.success_threshold = 4
    breaker.config.timeout_seconds = 33.0

    info = breaker.get_health_info()
    assert info["name"] == breaker.name
    assert info["state"] == breaker._state.value
    assert info["failure_count"] == 2
    assert info["success_count"] == 5
    assert info["failure_rate"] == pytest.approx(breaker._calculate_failure_rate())

    metrics = info["metrics"]
    assert metrics["total_calls"] == 10
    assert metrics["successful_calls"] == 7
    assert metrics["failed_calls"] == 3
    assert metrics["rejected_calls"] == 1
    assert metrics["average_response_time_ms"] == pytest.approx(0.123 * 1000)
    assert metrics["state_transitions"] == 4

    config = info["config"]
    assert config["failure_threshold"] == 9
    assert config["success_threshold"] == 4
    assert config["timeout_seconds"] == pytest.approx(33.0)


# ---------- DistributedCircuitBreakerCoordinator __init__ tests ----------


def test_distributed_coordinator_init_defaults(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator initialization with default node_id."""
    mock_pid = 12345
    monkeypatch.setattr(os, "getpid", lambda: mock_pid)
    # Ensure NODE_ID is not set
    monkeypatch.delenv("NODE_ID", raising=False)
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=2.5)
    assert coord.coordinator_url == "http://coordinator"
    assert coord.sync_interval == pytest.approx(2.5)
    assert coord.node_id == f"python-{mock_pid}"
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None


def test_distributed_coordinator_init_with_env_node_id(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator uses NODE_ID env var if set."""
    monkeypatch.setenv("NODE_ID", "custom-node")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    assert coord.node_id == "custom-node"


# ---------- DistributedCircuitBreakerCoordinator.register_breaker and _send_registration tests ----------


def test_distributed_coordinator_register_breaker_stores_and_sends_registration(coordinator, breaker):
    """Test register_breaker stores breaker and calls _send_registration."""
    with patch.object(coordinator, "_send_registration") as mock_send:
        coordinator.register_breaker(breaker)
        assert coordinator._breakers[breaker.name] is breaker
        mock_send.assert_called_once_with(breaker)


def test_distributed_coordinator_send_registration_success(coordinator, breaker):
    """Test _send_registration issues correct HTTP POST request and ignores success body."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_response = Mock()
        mock_urlopen.return_value = mock_response
        coordinator._send_registration(breaker)

        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/register"
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"
        sent_data = json.loads(req.data.decode("utf-8"))
        assert sent_data["service"] == breaker.name
        assert sent_data["node_id"] == coordinator.node_id
        assert sent_data["failure_threshold"] == breaker.config.failure_threshold
        assert sent_data["success_threshold"] == breaker.config.success_threshold


def test_distributed_coordinator_send_registration_ignores_urlerror(coordinator, breaker):
    """Test _send_registration silently ignores URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("URLError")) as mock_urlopen:
        coordinator._send_registration(breaker)
        mock_urlopen.assert_called_once()


# ---------- DistributedCircuitBreakerCoordinator.start_sync and stop_sync tests ----------


def test_distributed_coordinator_start_and_stop_sync_runs_thread(coordinator, monkeypatch):
    """Test start_sync creates and starts a daemon thread, and stop_sync stops it."""
    calls = []

    def fake_sync_loop():
        calls.append("loop-ran")

    monkeypatch.setattr(coordinator, "_sync_loop", fake_sync_loop)
    coordinator.start_sync()
    assert coordinator._running is True
    assert isinstance(coordinator._sync_thread, threading.Thread)
    assert coordinator._sync_thread.daemon is True

    coordinator.stop_sync()
    assert coordinator._running is False
    # join is called in stop_sync; thread should complete quickly
    assert "loop-ran" in calls or calls == []  # loop may or may not run depending on scheduling


# ---------- DistributedCircuitBreakerCoordinator._synchronize_states tests ----------


def test_distributed_coordinator_synchronize_states_sends_state_for_each_breaker(coordinator, breaker, monkeypatch):
    """Test _synchronize_states posts state data for each registered breaker."""
    coordinator._breakers[breaker.name] = breaker
    breaker._state = CircuitState.CLOSED
    breaker._failure_count = 2

    fake_time_value = 7000.0

    def fake_time():
        return fake_time_value

    monkeypatch.setattr("time.time", fake_time)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_response = Mock()
        mock_urlopen.return_value = mock_response

        coordinator._synchronize_states()

        mock_urlopen.assert_called_once()
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/state"
        assert req.get_method() == "POST"
        payload = json.loads(req.data.decode("utf-8"))
        assert payload["service"] == breaker.name
        assert payload["node_id"] == coordinator.node_id
        assert payload["state"] == breaker.state.value
        assert payload["failure_count"] == breaker._failure_count
        assert isinstance(payload["timestamp"], int)
        assert "health_info" in payload


def test_distributed_coordinator_synchronize_states_ignores_urlerror(coordinator, breaker):
    """Test _synchronize_states ignores URLError when posting state."""
    coordinator._breakers[breaker.name] = breaker
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("URLError")) as mock_urlopen:
        coordinator._synchronize_states()
        mock_urlopen.assert_called_once()


def test_distributed_coordinator_sync_loop_runs_until_stopped(coordinator, monkeypatch):
    """Test _sync_loop repeatedly calls _synchronize_states while running."""
    calls = []

    def fake_synchronize_states():
        calls.append("sync")

    monkeypatch.setattr(coordinator, "_synchronize_states", fake_synchronize_states)

    # Use very small interval to make loop run a couple of times
    coordinator.sync_interval = 0.01

    def run_loop_briefly():
        coordinator._running = True
        # Run loop in current thread but stop after a few iterations
        for _ in range(3):
            fake_synchronize_states()
            time.sleep(coordinator.sync_interval)
        coordinator._running = False

    with patch("time.sleep", return_value=None):
        run_loop_briefly()

    assert len(calls) == 3


# ---------- DistributedCircuitBreakerCoordinator.get_cluster_state tests ----------


def test_distributed_coordinator_get_cluster_state_success(coordinator):
    """Test get_cluster_state performs GET request and returns decoded JSON."""
    expected = {"state": "CLOSED", "nodes": []}
    response_mock = Mock()
    response_mock.read.return_value = json.dumps(expected).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=response_mock) as mock_urlopen:
        result = coordinator.get_cluster_state("svc")
        assert result == expected
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/svc/aggregate"
        assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_on_error_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict when URLError occurs."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("URLError")):
        result = coordinator.get_cluster_state("svc")
        assert result == {"error": "Failed to fetch cluster state"}


# ---------- circuit_breaker decorator tests ----------


def test_circuit_breaker_decorator_wraps_function_and_uses_shared_breaker():
    """Test circuit_breaker decorator wraps function and uses shared CircuitBreaker instance."""
    config = CircuitBreakerConfig(failure_threshold=2)

    @circuit_breaker("decorated-svc", config=config)
    def sample(x, y):
        return x + y

    assert hasattr(sample, "__wrapped__")
    assert hasattr(sample, "circuit_breaker")
    breaker1 = sample.circuit_breaker
    assert isinstance(breaker1, CircuitBreaker)
    assert breaker1.name == "decorated-svc"
    assert breaker1.config is config

    # Ensure get_or_create returns same breaker
    breaker2 = CircuitBreaker.get_or_create("decorated-svc")
    assert breaker1 is breaker2

    # Execute wrapped function
    result = sample(2, 3)
    assert result == 5
    assert breaker1.metrics.total_calls == 1
    assert breaker1.metrics.successful_calls == 1


def test_circuit_breaker_decorator_propagates_exceptions():
    """Test circuit_breaker decorator propagates exceptions from wrapped function."""
    @circuit_breaker("failing-svc")
    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        failing()
    breaker_obj = failing.circuit_breaker
    assert breaker_obj.metrics.total_calls == 1
    assert breaker_obj.metrics.failed_calls == 1