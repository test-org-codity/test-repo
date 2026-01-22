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
    """Provide a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test_service", config=default_config)


@pytest.fixture
def coordinator_instance():
    """Provide a DistributedCircuitBreakerCoordinator instance for testing."""
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


def test_circuit_breaker_initialization_defaults():
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


def test_circuit_breaker_get_or_create_creates_and_reuses_instance(default_config):
    """Test get_or_create creates a new instance and reuses it on subsequent calls."""
    cb1 = CircuitBreaker.get_or_create("svc", default_config)
    cb2 = CircuitBreaker.get_or_create("svc", default_config)
    assert cb1 is cb2
    assert CircuitBreaker._registry["svc"] is cb1


def test_circuit_breaker_state_open_to_half_open_after_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN after timeout."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + cb.config.timeout_seconds + 1

    monkeypatch.setattr(time, "time", fake_time)
    assert cb.state == CircuitState.HALF_OPEN
    assert cb._state == CircuitState.HALF_OPEN


def test_circuit_breaker_state_open_stays_open_before_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property remains OPEN before timeout expires."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + cb.config.timeout_seconds - 1

    monkeypatch.setattr(time, "time", fake_time)
    assert cb.state == CircuitState.OPEN
    assert cb._state == CircuitState.OPEN


def test_circuit_breaker_should_attempt_reset_false_without_opened_at(circuit_breaker_instance):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    cb = circuit_breaker_instance
    cb._opened_at = None
    assert cb._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_after_timeout(circuit_breaker_instance, monkeypatch):
    """Test _should_attempt_reset returns True after timeout has passed."""
    cb = circuit_breaker_instance
    base_time = time.time()
    cb._opened_at = base_time

    def fake_time():
        return base_time + cb.config.timeout_seconds + 0.1

    monkeypatch.setattr(time, "time", fake_time)
    assert cb._should_attempt_reset() is True


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(circuit_breaker_instance):
    """Test _transition_to OPEN sets opened_at and increments state_transitions."""
    cb = circuit_breaker_instance
    assert cb.metrics.state_transitions == 0
    cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb._opened_at is not None
    assert cb.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_counts(circuit_breaker_instance):
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
    cb._failure_count = 3
    cb._success_count = 2
    cb._opened_at = time.time()
    cb._sliding_window.extend([True, False])
    cb._transition_to(CircuitState.CLOSED)
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0


def test_circuit_breaker_execute_successful_operation_updates_metrics(circuit_breaker_instance, monkeypatch):
    """Test execute with successful operation updates metrics and returns result."""
    cb = circuit_breaker_instance

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
    assert cb.metrics.average_response_time == pytest.approx(0.1)
    assert cb._failure_count == 0


def test_circuit_breaker_execute_failure_raises_and_updates_metrics(circuit_breaker_instance, monkeypatch):
    """Test execute with failing operation raises and updates metrics and failure count."""
    cb = circuit_breaker_instance

    times = [1000.0, 1000.2]
    monkeypatch.setattr(time, "time", lambda: times.pop(0))

    def op():
        raise ValueError("fail")

    with pytest.raises(ValueError):
        cb.execute(op)

    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 0
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.average_response_time == pytest.approx(0.2)
    assert cb._failure_count == 1


def test_circuit_breaker_execute_rejected_calls_fallback_used(circuit_breaker_instance):
    """Test execute when request not allowed uses fallback and increments rejected_calls."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)

    op = Mock()
    fallback = Mock(return_value="fallback")

    result = cb.execute(op, fallback=fallback)

    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    op.assert_not_called()
    fallback.assert_called_once()


def test_circuit_breaker_execute_rejected_raises_open_error_without_fallback(circuit_breaker_instance, monkeypatch):
    """Test execute when request not allowed raises CircuitBreakerOpenError without fallback."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at

    def fake_time():
        return opened_at + 5

    monkeypatch.setattr(time, "time", fake_time)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(lambda: "ok")

    assert exc.value.name == cb.name
    remaining = cb.config.timeout_seconds - 5
    assert exc.value.remaining_time == pytest.approx(max(0, remaining))
    assert cb.metrics.rejected_calls == 1


def test_circuit_breaker_allow_request_closed_state_allows(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    assert cb._allow_request() is True


def test_circuit_breaker_allow_request_open_state_denies(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    assert cb._allow_request() is False


def test_circuit_breaker_allow_request_half_open_limited_calls(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls then denies."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.half_open_max_calls = 2

    assert cb._allow_request() is True
    assert cb._allow_request() is True
    assert cb._allow_request() is False
    assert cb._half_open_calls == 2


def test_circuit_breaker_record_success_in_half_open_closes_after_threshold(circuit_breaker_instance):
    """Test _record_success in HALF_OPEN transitions to CLOSED after reaching success_threshold."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.HALF_OPEN)
    cb.config.success_threshold = 2

    cb._record_success(0.1)
    assert cb._state == CircuitState.HALF_OPEN
    cb._record_success(0.2)
    assert cb._state == CircuitState.CLOSED
    assert cb._success_count == 0
    assert cb.metrics.successful_calls == 2
    assert cb.metrics.average_response_time == pytest.approx((0.1 + 0.2) / 2)


def test_circuit_breaker_record_success_in_closed_decrements_failure_count(circuit_breaker_instance):
    """Test _record_success in CLOSED decrements failure_count but not below zero."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2
    cb._record_success(0.1)
    assert cb._failure_count == 1
    cb._record_success(0.1)
    assert cb._failure_count == 0
    cb._record_success(0.1)
    assert cb._failure_count == 0


def test_circuit_breaker_record_failure_in_half_open_opens(circuit_breaker_instance):
    """Test _record_failure in HALF_OPEN transitions to OPEN."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.HALF_OPEN)
    cb._record_failure(0.1)
    assert cb._state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 1


def test_circuit_breaker_record_failure_in_closed_opens_on_failure_threshold(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens circuit when failure_threshold reached."""
    cb = circuit_breaker_instance
    cb.config.failure_threshold = 3
    cb._state = CircuitState.CLOSED

    cb._record_failure(0.1)
    cb._record_failure(0.1)
    assert cb._state == CircuitState.CLOSED
    cb._record_failure(0.1)
    assert cb._state == CircuitState.OPEN
    assert cb._failure_count == 3


def test_circuit_breaker_calculate_failure_rate_insufficient_window_returns_zero(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 when sliding window not full."""
    cb = circuit_breaker_instance
    cb._sliding_window.extend([True, False, False])
    rate = cb._calculate_failure_rate()
    assert rate == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns correct rate when window is full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 4
    cb._sliding_window = deque(maxlen=4)
    cb._sliding_window.extend([True, False, False, True])
    rate = cb._calculate_failure_rate()
    assert rate == pytest.approx(2 / 4)


def test_circuit_breaker_record_failure_opens_on_failure_rate_threshold(circuit_breaker_instance):
    """Test _record_failure opens circuit when failure rate threshold exceeded."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 4
    cb.config.failure_rate_threshold = 0.5
    cb._sliding_window = deque(maxlen=4)
    cb._state = CircuitState.CLOSED

    cb._sliding_window.extend([False, False, True, True])
    cb._failure_count = cb.config.failure_threshold - 1
    cb._record_failure(0.1)
    assert cb._state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_structure_and_values(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    cb = circuit_breaker_instance
    cb._failure_count = 2
    cb._success_count = 1
    cb.metrics.total_calls = 3
    cb.metrics.successful_calls = 1
    cb.metrics.failed_calls = 2
    cb.metrics.rejected_calls = 1
    cb.metrics.average_response_time = 0.123
    cb.metrics.state_transitions = 4

    info = cb.get_health_info()
    assert info["name"] == cb.name
    assert info["state"] == cb._state.value
    assert info["failure_count"] == 2
    assert info["success_count"] == 1
    assert info["metrics"]["total_calls"] == 3
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 2
    assert info["metrics"]["rejected_calls"] == 1
    assert info["metrics"]["state_transitions"] == 4
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(0.123 * 1000)
    assert info["config"]["failure_threshold"] == cb.config.failure_threshold
    assert info["config"]["success_threshold"] == cb.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(cb.config.timeout_seconds)


def test_distributed_coordinator_initialization_defaults():
    """Test DistributedCircuitBreakerCoordinator initialization."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test", sync_interval=1.5)
    assert coord.coordinator_url == "http://coordinator.test"
    assert coord.sync_interval == pytest.approx(1.5)
    assert isinstance(coord._breakers, dict)
    assert coord._running is False
    assert coord._sync_thread is None
    assert coord.node_id.startswith("python-")


def test_distributed_coordinator_register_breaker_sends_registration(coordinator_instance, circuit_breaker_instance):
    """Test register_breaker stores breaker and calls _send_registration."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch.object(coord, "_send_registration") as mock_send:
        coord.register_breaker(cb)
        assert coord._breakers["test_service"] is cb
        mock_send.assert_called_once_with(cb)


def test_distributed_coordinator_send_registration_success(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration sends correct HTTP request and ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord._send_registration(cb)
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert coord.coordinator_url in req.full_url
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_send_registration_handles_urlerror(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration silently ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("err")):
        coord._send_registration(cb)  # Should not raise


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance):
    """Test start_sync starts thread and stop_sync stops it."""
    coord = coordinator_instance

    with patch.object(coord, "_sync_loop") as mock_loop:
        coord.start_sync()
        assert coord._running is True
        assert coord._sync_thread is not None
        assert coord._sync_thread.daemon is True

        coord.stop_sync()
        assert coord._running is False
        mock_loop.assert_called()


def test_distributed_coordinator_sync_loop_calls_synchronize_states(coordinator_instance, monkeypatch):
    """Test _sync_loop repeatedly calls _synchronize_states while running."""
    coord = coordinator_instance
    calls = []

    def fake_sleep(_):
        coord._running = False

    monkeypatch.setattr(time, "sleep", fake_sleep)

    with patch.object(coord, "_synchronize_states") as mock_sync:
        coord._running = True
        coord._sync_loop()
        mock_sync.assert_called_once()


def test_distributed_coordinator_synchronize_states_sends_state(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states sends breaker state to coordinator."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    coord._breakers["test_service"] = cb

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord._synchronize_states()
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert "/circuit-breakers/state" in req.full_url
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_synchronize_states_handles_urlerror(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states silently ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    coord._breakers["test_service"] = cb

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("err")):
        coord._synchronize_states()  # Should not raise


def test_distributed_coordinator_get_cluster_state_success(coordinator_instance):
    """Test get_cluster_state returns parsed JSON on success."""
    coord = coordinator_instance
    response_data = {"state": "OK"}

    mock_response = Mock()
    mock_response.read.return_value = json.dumps(response_data).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=mock_response) as mock_urlopen:
        result = coord.get_cluster_state("svc")
        assert result == response_data
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert "/circuit-breakers/svc/aggregate" in req.full_url
        assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_handles_urlerror(coordinator_instance):
    """Test get_cluster_state returns error dict on URLError."""
    coord = coordinator_instance

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception("err")):
        result = coord.get_cluster_state("svc")
        assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker(monkeypatch):
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    mock_breaker = Mock(spec=CircuitBreaker)
    mock_breaker.execute = Mock(return_value="wrapped_result")

    with patch.object(CircuitBreaker, "get_or_create", return_value=mock_breaker):
        @circuit_breaker("decorated_service")
        def sample_func(x, y):
            return x + y

        result = sample_func(1, 2)
        assert result == "wrapped_result"
        mock_breaker.execute.assert_called_once()
        execute_arg = mock_breaker.execute.call_args[0][0]
        assert execute_arg() == 3
        assert getattr(sample_func, "circuit_breaker") is mock_breaker
        assert getattr(sample_func, "__wrapped__") is sample_func.__wrapped__