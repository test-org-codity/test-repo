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
def metrics_instance():
    """Provide a CircuitBreakerMetrics instance for testing."""
    return CircuitBreakerMetrics()


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


def test_circuit_breaker_metrics_initialization(metrics_instance):
    """Test CircuitBreakerMetrics initialization values."""
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
    err = CircuitBreakerOpenError("svc", 12.3456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)
    assert "12.35" in str(err)


def test_circuit_breaker_init_defaults(default_config):
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


def test_circuit_breaker_state_closed_without_timeout(circuit_breaker_instance):
    """Test state property returns CLOSED when breaker is closed."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_state_open_no_reset_attempt(circuit_breaker_instance, monkeypatch):
    """Test state remains OPEN when timeout has not elapsed."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._opened_at = time.time()
    monkeypatch.setattr(cb, "_should_attempt_reset", lambda: False)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_state_open_to_half_open_on_timeout(circuit_breaker_instance, monkeypatch):
    """Test state transitions from OPEN to HALF_OPEN when timeout has elapsed."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._opened_at = time.time() - cb.config.timeout_seconds - 1

    # Use real _should_attempt_reset but control time via monkeypatch
    with patch("time.time", return_value=cb._opened_at + cb.config.timeout_seconds + 0.1):
        assert cb.state == CircuitState.HALF_OPEN
        assert cb._state == CircuitState.HALF_OPEN


def test_circuit_breaker_should_attempt_reset_false_when_opened_at_none(circuit_breaker_instance):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    cb = circuit_breaker_instance
    cb._opened_at = None
    assert cb._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_based_on_timeout(circuit_breaker_instance, monkeypatch):
    """Test _should_attempt_reset returns True when timeout has elapsed."""
    cb = circuit_breaker_instance
    cb._opened_at = 100.0
    cb.config.timeout_seconds = 10.0
    with patch("time.time", return_value=111.0):
        assert cb._should_attempt_reset() is True
    with patch("time.time", return_value=109.0):
        assert cb._should_attempt_reset() is False


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(circuit_breaker_instance):
    """Test _transition_to OPEN sets opened_at and increments state_transitions."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    before = cb.metrics.state_transitions
    with patch("time.time", return_value=123.456):
        cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb._opened_at == pytest.approx(123.456)
    assert cb.metrics.state_transitions == before + 1


def test_circuit_breaker_transition_to_half_open_resets_counters(circuit_breaker_instance):
    """Test _transition_to HALF_OPEN resets half_open_calls and success_count."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._half_open_calls = 5
    cb._success_count = 7
    before = cb.metrics.state_transitions
    cb._transition_to(CircuitState.HALF_OPEN)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._half_open_calls == 0
    assert cb._success_count == 0
    assert cb.metrics.state_transitions == before + 1


def test_circuit_breaker_transition_to_closed_resets_counts_and_window(circuit_breaker_instance):
    """Test _transition_to CLOSED resets failure_count, success_count, opened_at, and sliding window."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._failure_count = 3
    cb._success_count = 2
    cb._opened_at = 123.0
    cb._sliding_window.extend([True, False])
    before = cb.metrics.state_transitions
    cb._transition_to(CircuitState.CLOSED)
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0
    assert cb.metrics.state_transitions == before + 1


def test_circuit_breaker_allow_request_closed_state(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    assert cb._allow_request() is True


def test_circuit_breaker_allow_request_open_state(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    assert cb._allow_request() is False


def test_circuit_breaker_allow_request_half_open_within_limit(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN increments half_open_calls and allows up to max."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.half_open_max_calls = 2
    cb._half_open_calls = 0
    assert cb._allow_request() is True
    assert cb._half_open_calls == 1
    assert cb._allow_request() is True
    assert cb._half_open_calls == 2
    assert cb._allow_request() is False
    assert cb._half_open_calls == 2


def test_circuit_breaker_execute_successful_call_updates_metrics_and_returns_result(circuit_breaker_instance):
    """Test execute with successful operation updates metrics and returns result."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    op = Mock(return_value="ok")

    with patch("time.time", side_effect=[100.0, 100.1]):
        result = cb.execute(op)

    assert result == "ok"
    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.failed_calls == 0
    assert cb.metrics.average_response_time == pytest.approx(0.1)
    assert list(cb._sliding_window) == [True]


def test_circuit_breaker_execute_failure_increments_failure_and_raises(circuit_breaker_instance):
    """Test execute with failing operation increments failure metrics and re-raises exception."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED

    class CustomError(Exception):
        pass

    def failing():
        raise CustomError("boom")

    with patch("time.time", side_effect=[100.0, 100.2]):
        with pytest.raises(CustomError):
            cb.execute(failing)

    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.successful_calls == 0
    assert cb.metrics.average_response_time == pytest.approx(0.2)
    assert list(cb._sliding_window) == [False]


def test_circuit_breaker_execute_rejected_without_fallback_raises_open_error(circuit_breaker_instance):
    """Test execute when request not allowed and no fallback raises CircuitBreakerOpenError."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._opened_at = time.time() - 1
    cb.config.timeout_seconds = 10.0

    op = Mock()

    with patch.object(cb, "_allow_request", return_value=False):
        with patch("time.time", return_value=cb._opened_at + 5):
            with pytest.raises(CircuitBreakerOpenError) as exc:
                cb.execute(op)

    assert cb.metrics.rejected_calls == 1
    assert not op.called
    assert exc.value.name == cb.name
    assert exc.value.remaining_time == pytest.approx(5.0)


def test_circuit_breaker_execute_rejected_with_fallback_uses_fallback(circuit_breaker_instance):
    """Test execute when request not allowed uses fallback and does not raise."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    cb._opened_at = time.time()
    cb.config.timeout_seconds = 10.0

    op = Mock()
    fallback = Mock(return_value="fallback")

    with patch.object(cb, "_allow_request", return_value=False):
        result = cb.execute(op, fallback=fallback)

    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    assert not op.called
    fallback.assert_called_once()


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(circuit_breaker_instance):
    """Test _record_success in HALF_OPEN increments success_count and may close breaker."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.success_threshold = 2
    cb._success_count = 0

    with patch("time.time", return_value=200.0):
        cb._record_success(0.1)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._success_count == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.last_success_time == pytest.approx(200.0)

    with patch("time.time", return_value=201.0):
        cb._record_success(0.2)
    assert cb._state == CircuitState.CLOSED
    assert cb._success_count == 0  # reset on transition to CLOSED
    assert cb.metrics.successful_calls == 2
    assert cb.metrics.last_success_time == pytest.approx(201.0)


def test_circuit_breaker_record_success_in_closed_decrements_failure_count(circuit_breaker_instance):
    """Test _record_success in CLOSED decrements failure_count but not below zero."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2

    with patch("time.time", return_value=300.0):
        cb._record_success(0.1)
    assert cb._failure_count == 1

    with patch("time.time", return_value=301.0):
        cb._record_success(0.1)
    assert cb._failure_count == 0

    with patch("time.time", return_value=302.0):
        cb._record_success(0.1)
    assert cb._failure_count == 0


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(circuit_breaker_instance):
    """Test _record_failure in HALF_OPEN transitions breaker back to OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN

    with patch("time.time", return_value=400.0):
        cb._record_failure(0.2)

    assert cb._state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.last_failure_time == pytest.approx(400.0)


def test_circuit_breaker_record_failure_in_closed_opens_on_threshold(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens breaker when failure_threshold reached."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb.config.failure_threshold = 3
    cb.config.sliding_window_size = 3
    cb._sliding_window = deque(maxlen=3)

    with patch("time.time", return_value=500.0):
        cb._record_failure(0.1)
        cb._record_failure(0.1)
        assert cb._state == CircuitState.CLOSED
        cb._record_failure(0.1)

    assert cb._failure_count == 3
    assert cb._state == CircuitState.OPEN


def test_circuit_breaker_record_failure_uses_failure_rate_threshold(circuit_breaker_instance):
    """Test _record_failure opens breaker when failure rate threshold exceeded."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb.config.sliding_window_size = 4
    cb.config.failure_rate_threshold = 0.5
    cb._sliding_window = deque(maxlen=4)
    cb.config.failure_threshold = 100  # high to force rate-based opening

    with patch("time.time", return_value=600.0):
        cb._record_failure(0.1)
        cb._record_success(0.1)
        cb._record_failure(0.1)
        cb._record_failure(0.1)

    # sliding window: [False, True, False, False] => 3/4 failures = 0.75 > 0.5
    assert cb._state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_insufficient_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 when sliding window not full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 5
    cb._sliding_window = deque(maxlen=5)
    cb._sliding_window.extend([False, True, False])
    rate = cb._calculate_failure_rate()
    assert rate == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns correct failure rate when window full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 4
    cb._sliding_window = deque(maxlen=4)
    cb._sliding_window.extend([False, True, False, False])
    rate = cb._calculate_failure_rate()
    assert rate == pytest.approx(3 / 4)


def test_circuit_breaker_get_health_info_structure_and_values(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    cb = circuit_breaker_instance
    cb.name = "health_svc"
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2
    cb._success_count = 5
    cb.config.failure_threshold = 10
    cb.config.success_threshold = 4
    cb.config.timeout_seconds = 20.0
    cb.config.sliding_window_size = 2
    cb._sliding_window = deque([True, False], maxlen=2)
    cb.metrics.total_calls = 7
    cb.metrics.successful_calls = 5
    cb.metrics.failed_calls = 2
    cb.metrics.rejected_calls = 1
    cb.metrics.average_response_time = 0.123
    cb.metrics.state_transitions = 3

    info = cb.get_health_info()
    assert info["name"] == "health_svc"
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 2
    assert info["success_count"] == 5
    assert info["failure_rate"] == pytest.approx(1 / 2)
    assert info["metrics"]["total_calls"] == 7
    assert info["metrics"]["successful_calls"] == 5
    assert info["metrics"]["failed_calls"] == 2
    assert info["metrics"]["rejected_calls"] == 1
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(0.123 * 1000)
    assert info["metrics"]["state_transitions"] == 3
    assert info["config"]["failure_threshold"] == 10
    assert info["config"]["success_threshold"] == 4
    assert info["config"]["timeout_seconds"] == pytest.approx(20.0)


def test_distributed_coordinator_init_defaults():
    """Test DistributedCircuitBreakerCoordinator initialization."""
    with patch.dict(os.environ, {}, clear=True):
        coord = DistributedCircuitBreakerCoordinator("http://coordinator.test", sync_interval=1.5)
        assert coord.coordinator_url == "http://coordinator.test"
        assert coord.sync_interval == pytest.approx(1.5)
        assert coord._breakers == {}
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


def test_distributed_coordinator_send_registration_makes_http_request(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration sends correct HTTP POST request."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    cb.config.failure_threshold = 7
    cb.config.success_threshold = 4
    coord.node_id = "node-123"

    with patch("urllib.request.urlopen") as mock_urlopen:
        coord._send_registration(cb)

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == "http://coordinator.test/circuit-breakers/register"
    assert req.get_method() == "POST"
    assert req.headers["Content-Type"] == "application/json"
    sent_data = json.loads(req.data.decode("utf-8"))
    assert sent_data["service"] == "test_service"
    assert sent_data["node_id"] == "node-123"
    assert sent_data["failure_threshold"] == 7
    assert sent_data["success_threshold"] == 4


def test_distributed_coordinator_send_registration_handles_url_error(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration silently ignores URLError."""
    coord = coordinator_instance
    cb = circuit_breaker_instance

    with patch("urllib.request.urlopen", side_effect=Exception("network")) as mock_urlopen:
        coord._send_registration(cb)

    mock_urlopen.assert_called_once()


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance):
    """Test start_sync starts a daemon thread and stop_sync stops it."""
    coord = coordinator_instance

    with patch.object(coord, "_sync_loop", wraps=coord._sync_loop) as mock_loop:
        coord.start_sync()
        assert coord._running is True
        assert coord._sync_thread is not None
        assert coord._sync_thread.daemon is True

        # Allow loop to run at least once
        time.sleep(0.03)
        coord.stop_sync()
        assert coord._running is False
        coord._sync_thread.join(timeout=1)
        assert not coord._sync_thread.is_alive() or coord._sync_thread is None or coord._running is False

    # _sync_loop should have been called at least once
    assert mock_loop.call_count >= 1


def test_distributed_coordinator_sync_loop_calls_synchronize_states(coordinator_instance):
    """Test _sync_loop repeatedly calls _synchronize_states while running."""
    coord = coordinator_instance
    coord.sync_interval = 0.01

    call_counter = {"count": 0}

    def fake_sync():
        call_counter["count"] += 1
        if call_counter["count"] >= 3:
            coord._running = False

    coord._running = True
    with patch.object(coord, "_synchronize_states", side_effect=fake_sync) as mock_sync:
        coord._sync_loop()

    assert mock_sync.call_count >= 3
    assert call_counter["count"] >= 3


def test_distributed_coordinator_synchronize_states_posts_state(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states sends state for each registered breaker."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    coord._breakers["test_service"] = cb
    coord.node_id = "node-xyz"
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2

    with patch("urllib.request.urlopen") as mock_urlopen, patch("time.time", return_value=1000.0):
        coord._synchronize_states()

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == "http://coordinator.test/circuit-breakers/state"
    assert req.get_method() == "POST"
    assert req.headers["Content-Type"] == "application/json"
    sent_data = json.loads(req.data.decode("utf-8"))
    assert sent_data["service"] == "test_service"
    assert sent_data["node_id"] == "node-xyz"
    assert sent_data["state"] == "CLOSED"
    assert sent_data["failure_count"] == 2
    assert sent_data["timestamp"] == int(1000.0 * 1000)
    assert "health_info" in sent_data
    assert sent_data["health_info"]["name"] == "test_service"


def test_distributed_coordinator_synchronize_states_handles_url_error(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states ignores URLError exceptions."""
    coord = coordinator_instance
    cb = circuit_breaker_instance
    coord._breakers["test_service"] = cb

    with patch("urllib.request.urlopen", side_effect=Exception("network")) as mock_urlopen:
        coord._synchronize_states()

    mock_urlopen.assert_called_once()


def test_distributed_coordinator_get_cluster_state_success(coordinator_instance):
    """Test get_cluster_state returns parsed JSON on success."""
    coord = coordinator_instance
    response_data = {"state": "OK"}

    mock_response = Mock()
    mock_response.read.return_value = json.dumps(response_data).encode("utf-8")

    with patch("urllib.request.urlopen", return_value=mock_response) as mock_urlopen:
        result = coord.get_cluster_state("svc")

    assert result == response_data
    req = mock_urlopen.call_args[0[0]]
    assert req.full_url == "http://coordinator.test/circuit-breakers/svc/aggregate"
    assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_error(coordinator_instance):
    """Test get_cluster_state returns error dict on URLError."""
    coord = coordinator_instance

    with patch("urllib.request.urlopen", side_effect=Exception("network")):
        result = coord.get_cluster_state("svc")

    assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    with patch.object(CircuitBreaker, "get_or_create") as mock_get_or_create:
        mock_breaker = Mock(spec=CircuitBreaker)
        mock_get_or_create.return_value = mock_breaker
        mock_breaker.execute.side_effect = lambda op: op()

        @circuit_breaker("decorated_svc")
        def sample(x, y):
            return x + y

        assert hasattr(sample, "circuit_breaker")
        assert sample.circuit_breaker is mock_breaker
        assert sample.__wrapped__ is not None

        result = sample(2, 3)
        assert result == 5
        mock_breaker.execute.assert_called_once()
        # Ensure execute was called with a callable
        assert callable(mock_breaker.execute.call_args[0][0])