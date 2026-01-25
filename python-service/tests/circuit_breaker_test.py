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
    """Reset CircuitBreaker registry before each test to avoid cross-test interference."""
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
    return CircuitBreaker(name="test_breaker", config=default_config)


@pytest.fixture
def metrics_instance():
    """Provide a CircuitBreakerMetrics instance for testing."""
    return CircuitBreakerMetrics()


@pytest.fixture
def coordinator_instance(tmp_path):
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


def test_circuit_breaker_metrics_initialization(metrics_instance):
    """Test CircuitBreakerMetrics initializes with correct default values."""
    m = metrics_instance
    assert m.total_calls == 0
    assert m.successful_calls == 0
    assert m.failed_calls == 0
    assert m.rejected_calls == 0
    assert m.state_transitions == 0
    assert m.last_failure_time is None
    assert m.last_success_time is None
    assert m.average_response_time == pytest.approx(0.0)
    assert isinstance(m._response_times, deque)
    assert m._response_times.maxlen == 100


def test_circuit_breaker_metrics_record_response_time_updates_average(metrics_instance):
    """Test record_response_time updates internal deque and average_response_time."""
    m = metrics_instance
    m.record_response_time(0.1)
    m.record_response_time(0.3)
    assert len(m._response_times) == 2
    assert m.average_response_time == pytest.approx((0.1 + 0.3) / 2)


def test_circuit_breaker_open_error_message_and_attributes():
    """Test CircuitBreakerOpenError stores name and remaining_time and formats message."""
    err = CircuitBreakerOpenError("service_a", 12.3456)
    assert err.name == "service_a"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'service_a' is open." in str(err)
    assert "Retry after" in str(err)


def test_circuit_breaker_get_or_create_creates_and_reuses_instance(default_config):
    """Test get_or_create creates a new breaker and reuses existing one for same name."""
    b1 = CircuitBreaker.get_or_create("svc", default_config)
    b2 = CircuitBreaker.get_or_create("svc", default_config)
    b3 = CircuitBreaker.get_or_create("other", default_config)

    assert isinstance(b1, CircuitBreaker)
    assert b1 is b2
    assert b1 is not b3
    assert b1.name == "svc"
    assert b3.name == "other"


def test_circuit_breaker_initial_state_and_metrics(circuit_breaker_instance):
    """Test CircuitBreaker initialization sets correct defaults."""
    cb = circuit_breaker_instance
    assert cb.name == "test_breaker"
    assert cb.state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._half_open_calls == 0
    assert cb._opened_at is None
    assert isinstance(cb._sliding_window, deque)
    assert cb._sliding_window.maxlen == cb.config.sliding_window_size
    assert isinstance(cb.metrics, CircuitBreakerMetrics)


def test_circuit_breaker_state_open_to_half_open_after_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN after timeout."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    assert cb.state == CircuitState.OPEN

    fake_time = cb._opened_at + cb.config.timeout_seconds + 1
    monkeypatch.setattr(time, "time", lambda: fake_time)

    assert cb.state == CircuitState.HALF_OPEN
    assert cb._state == CircuitState.HALF_OPEN


def test_circuit_breaker_should_attempt_reset_false_when_never_opened(circuit_breaker_instance):
    """Test _should_attempt_reset returns False when breaker was never opened."""
    cb = circuit_breaker_instance
    assert cb._opened_at is None
    assert cb._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_based_on_timeout(circuit_breaker_instance, monkeypatch):
    """Test _should_attempt_reset respects timeout_seconds."""
    cb = circuit_breaker_instance
    now = time.time()
    cb._opened_at = now

    monkeypatch.setattr(time, "time", lambda: now + cb.config.timeout_seconds - 1)
    assert cb._should_attempt_reset() is False

    monkeypatch.setattr(time, "time", lambda: now + cb.config.timeout_seconds + 0.1)
    assert cb._should_attempt_reset() is True


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(circuit_breaker_instance):
    """Test _transition_to OPEN sets opened_at and increments state_transitions."""
    cb = circuit_breaker_instance
    before = cb.metrics.state_transitions
    cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb._opened_at is not None
    assert cb.metrics.state_transitions == before + 1


def test_circuit_breaker_transition_to_half_open_resets_counts(circuit_breaker_instance):
    """Test _transition_to HALF_OPEN resets half_open_calls and success_count."""
    cb = circuit_breaker_instance
    cb._half_open_calls = 5
    cb._success_count = 7
    cb._transition_to(CircuitState.HALF_OPEN)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._half_open_calls == 0
    assert cb._success_count == 0


def test_circuit_breaker_transition_to_closed_resets_counters_and_window(circuit_breaker_instance):
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


def test_circuit_breaker_allow_request_closed_state_allows(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.CLOSED)
    assert cb._allow_request() is True


def test_circuit_breaker_allow_request_open_state_rejects(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    assert cb._allow_request() is False


def test_circuit_breaker_allow_request_half_open_respects_max_calls(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls then rejects."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.HALF_OPEN)
    max_calls = cb.config.half_open_max_calls

    allowed_results = [cb._allow_request() for _ in range(max_calls)]
    assert all(allowed_results)

    assert cb._allow_request() is False
    assert cb._half_open_calls == max_calls


def test_circuit_breaker_execute_successful_operation(circuit_breaker_instance):
    """Test execute calls operation, records success, and returns result."""
    cb = circuit_breaker_instance
    op = Mock(return_value="ok")

    result = cb.execute(op)

    assert result == "ok"
    op.assert_called_once()
    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.failed_calls == 0
    assert len(cb._sliding_window) == 1
    assert cb._sliding_window[0] is True


def test_circuit_breaker_execute_failure_records_and_raises(circuit_breaker_instance):
    """Test execute records failure and re-raises the original exception."""
    cb = circuit_breaker_instance

    class CustomError(Exception):
        pass

    op = Mock(side_effect=CustomError("fail"))

    with pytest.raises(CustomError):
        cb.execute(op)

    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.successful_calls == 0
    assert len(cb._sliding_window) == 1
    assert cb._sliding_window[0] is False


def test_circuit_breaker_execute_open_state_uses_fallback(circuit_breaker_instance):
    """Test execute uses fallback when breaker is open and fallback is provided."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)

    op = Mock()
    fallback = Mock(return_value="fallback")

    result = cb.execute(op, fallback=fallback)

    assert result == "fallback"
    op.assert_not_called()
    fallback.assert_called_once()
    assert cb.metrics.rejected_calls == 1


def test_circuit_breaker_execute_open_state_raises_open_error_without_fallback(circuit_breaker_instance, monkeypatch):
    """Test execute raises CircuitBreakerOpenError when open and no fallback."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.OPEN)
    opened_at = cb._opened_at
    assert opened_at is not None

    fake_now = opened_at + 1.0
    monkeypatch.setattr(time, "time", lambda: fake_now)

    op = Mock()

    with pytest.raises(CircuitBreakerOpenError) as exc_info:
        cb.execute(op)

    err = exc_info.value
    assert err.name == cb.name
    remaining = cb.config.timeout_seconds - (fake_now - opened_at)
    assert err.remaining_time == pytest.approx(max(0, remaining))
    op.assert_not_called()
    assert cb.metrics.rejected_calls == 1


def test_circuit_breaker_record_success_in_closed_decrements_failure_count(circuit_breaker_instance):
    """Test _record_success in CLOSED state decrements failure_count but not below zero."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.CLOSED)
    cb._failure_count = 2

    cb._record_success(0.05)
    assert cb._failure_count == 1

    cb._record_success(0.05)
    assert cb._failure_count == 0

    cb._record_success(0.05)
    assert cb._failure_count == 0


def test_circuit_breaker_record_success_in_half_open_closes_after_threshold(circuit_breaker_instance):
    """Test _record_success in HALF_OPEN transitions to CLOSED after success_threshold successes."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.HALF_OPEN)
    threshold = cb.config.success_threshold

    for i in range(threshold - 1):
        cb._record_success(0.01)
        assert cb.state == CircuitState.HALF_OPEN

    cb._record_success(0.01)
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_record_failure_in_half_open_opens_breaker(circuit_breaker_instance):
    """Test _record_failure in HALF_OPEN transitions to OPEN."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.HALF_OPEN)
    cb._record_failure(0.02)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_record_failure_in_closed_opens_on_failure_threshold(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens breaker when failure_threshold reached."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.CLOSED)
    cb.config.failure_threshold = 3

    for i in range(2):
        cb._record_failure(0.01)
        assert cb.state == CircuitState.CLOSED

    cb._record_failure(0.01)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_requires_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full."""
    cb = circuit_breaker_instance
    size = cb.config.sliding_window_size

    for i in range(size - 1):
        cb._sliding_window.append(False)

    assert cb._calculate_failure_rate() == pytest.approx(0.0)

    cb._sliding_window.append(False)
    assert cb._calculate_failure_rate() == pytest.approx(1.0)


def test_circuit_breaker_record_failure_uses_failure_rate_threshold(circuit_breaker_instance):
    """Test _record_failure opens breaker when failure_rate_threshold exceeded."""
    cb = circuit_breaker_instance
    cb._transition_to(CircuitState.CLOSED)
    cb.config.sliding_window_size = 4
    cb._sliding_window = deque(maxlen=cb.config.sliding_window_size)
    cb.config.failure_threshold = 100
    cb.config.failure_rate_threshold = 0.5

    cb._sliding_window.extend([True, False, False])
    cb._failure_count = 1

    cb._record_failure(0.01)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_structure_and_values(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    cb = circuit_breaker_instance
    cb._failure_count = 2
    cb._success_count = 1
    cb._sliding_window.extend([True, False, False, True, False, True, False, True, False, True])

    info = cb.get_health_info()

    assert info["name"] == cb.name
    assert info["state"] == cb.state.value
    assert info["failure_count"] == 2
    assert info["success_count"] == 1
    assert isinstance(info["failure_rate"], float)
    assert "metrics" in info
    assert "config" in info
    assert info["config"]["failure_threshold"] == cb.config.failure_threshold
    assert info["config"]["success_threshold"] == cb.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(cb.config.timeout_seconds)


def test_distributed_coordinator_initialization(coordinator_instance):
    """Test DistributedCircuitBreakerCoordinator initialization."""
    coord = coordinator_instance
    assert coord.coordinator_url == "http://coordinator.test"
    assert coord.sync_interval == pytest.approx(0.01)
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None
    assert coord.node_id is not None


def test_distributed_coordinator_register_breaker_sends_registration(coordinator_instance, circuit_breaker_instance):
    """Test register_breaker stores breaker and calls _send_registration."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch.object(coord, "_send_registration") as mock_send:
        coord.register_breaker(cb)
        assert coord._breakers[cb.name] is cb
        mock_send.assert_called_once_with(cb)


def test_distributed_coordinator_send_registration_makes_http_request(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration sends correct HTTP POST request and ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord._send_registration(cb)
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception):
        coord._send_registration(cb)


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance):
    """Test start_sync starts a daemon thread and stop_sync stops it."""
    coord = coordinator_instance

    with patch.object(coord, "_sync_loop") as mock_loop:
        coord.start_sync()
        assert coord._running is True
        assert isinstance(coord._sync_thread, threading.Thread)
        assert coord._sync_thread.daemon is True

        coord.stop_sync()
        assert coord._running is False
        mock_loop.assert_called()


def test_distributed_coordinator_sync_loop_calls_synchronize_states(coordinator_instance, monkeypatch):
    """Test _sync_loop repeatedly calls _synchronize_states until stopped."""
    coord = coordinator_instance
    calls = []

    def fake_sync():
        calls.append(1)
        if len(calls) >= 3:
            coord._running = False

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)
    monkeypatch.setattr(time, "sleep", lambda x: None)

    coord._running = True
    coord._sync_loop()

    assert len(calls) >= 3


def test_distributed_coordinator_synchronize_states_posts_state(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states posts breaker state to coordinator and ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    coord._breakers[cb.name] = cb

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord._synchronize_states()
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/state")
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception):
        coord._synchronize_states()


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
        assert req.full_url.endswith("/circuit-breakers/svc/aggregate")
        assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_error(coordinator_instance):
    """Test get_cluster_state returns error dict when URLError occurs."""
    coord = coordinator_instance

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=Exception):
        result = coord.get_cluster_state("svc")
        assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    with patch("src.circuit_breaker.CircuitBreaker.get_or_create") as mock_get_or_create:
        mock_breaker = Mock(spec=CircuitBreaker)
        mock_breaker.execute.side_effect = lambda op: op()
        mock_get_or_create.return_value = mock_breaker

        @circuit_breaker("decorated_service")
        def sample(x, y):
            return x + y

        result = sample(2, 3)
        assert result == 5
        mock_get_or_create.assert_called_once_with("decorated_service", None)
        assert hasattr(sample, "__wrapped__")
        assert hasattr(sample, "circuit_breaker")
        mock_breaker.execute.assert_called_once()
        op = mock_breaker.execute.call_args[0][0]
        assert op() == 5


def test_circuit_breaker_metrics_average_response_time_uses_pytest_approx(metrics_instance):
    """Test average_response_time is compared using pytest.approx."""
    m = metrics_instance
    m.record_response_time(0.1)
    assert m.average_response_time == pytest.approx(0.1)