import time
import threading
import json
import os
from collections import deque
from unittest.mock import Mock, patch

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
    """Reset CircuitBreaker registry before each test to avoid cross-test pollution."""
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


# -----------------------------
# CircuitState tests
# -----------------------------


def test_circuit_state_enum_values():
    """Test CircuitState enum has expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


# -----------------------------
# CircuitBreakerConfig tests
# -----------------------------


def test_circuit_breaker_config_defaults():
    """Test CircuitBreakerConfig default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuit_breaker_config_custom_values():
    """Test CircuitBreakerConfig with custom values."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=1,
        timeout_seconds=5.5,
        half_open_max_calls=10,
        sliding_window_size=20,
        failure_rate_threshold=0.75,
    )
    assert cfg.failure_threshold == 2
    assert cfg.success_threshold == 1
    assert cfg.timeout_seconds == pytest.approx(5.5)
    assert cfg.half_open_max_calls == 10
    assert cfg.sliding_window_size == 20
    assert cfg.failure_rate_threshold == pytest.approx(0.75)


# -----------------------------
# CircuitBreakerMetrics tests
# -----------------------------


def test_circuit_breaker_metrics_initial_state():
    """Test CircuitBreakerMetrics initializes with expected defaults."""
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


def test_circuit_breaker_metrics_record_response_time_single():
    """Test record_response_time updates average_response_time for a single call."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    assert metrics.average_response_time == pytest.approx(0.1)


def test_circuit_breaker_metrics_record_response_time_multiple():
    """Test record_response_time computes correct average over multiple calls."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    metrics.record_response_time(0.2)
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3 + 0.2) / 3)


def test_circuit_breaker_metrics_response_time_maxlen():
    """Test record_response_time respects maxlen of internal deque."""
    metrics = CircuitBreakerMetrics()
    for i in range(150):
        metrics.record_response_time(0.01 * i)
    assert len(metrics._response_times) == 100
    # Average should be over last 100 entries
    expected_avg = sum(0.01 * i for i in range(50, 150)) / 100
    assert metrics.average_response_time == pytest.approx(expected_avg)


# -----------------------------
# CircuitBreakerOpenError tests
# -----------------------------


def test_circuit_breaker_open_error_message_and_attrs():
    """Test CircuitBreakerOpenError stores name and remaining_time and formats message."""
    err = CircuitBreakerOpenError("svc", 12.3456)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)
    assert "12.35" in str(err)


# -----------------------------
# CircuitBreaker initialization and registry tests
# -----------------------------


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


def test_circuit_breaker_get_or_create_creates_once(default_config):
    """Test get_or_create returns same instance for same name and stores in registry."""
    cb1 = CircuitBreaker.get_or_create("svc", default_config)
    cb2 = CircuitBreaker.get_or_create("svc", default_config)
    assert cb1 is cb2
    assert CircuitBreaker._registry["svc"] is cb1


def test_circuit_breaker_get_or_create_different_names(default_config):
    """Test get_or_create returns different instances for different names."""
    cb1 = CircuitBreaker.get_or_create("svc1", default_config)
    cb2 = CircuitBreaker.get_or_create("svc2", default_config)
    assert cb1 is not cb2
    assert CircuitBreaker._registry["svc1"] is cb1
    assert CircuitBreaker._registry["svc2"] is cb2


# -----------------------------
# CircuitBreaker state and transitions tests
# -----------------------------


def test_circuit_breaker_state_closed_no_reset(circuit_breaker_instance):
    """Test state property returns CLOSED when not opened."""
    cb = circuit_breaker_instance
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_should_attempt_reset_false_when_not_opened(circuit_breaker_instance):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    cb = circuit_breaker_instance
    cb._opened_at = None
    assert cb._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_based_on_timeout(circuit_breaker_instance, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout_seconds has passed."""
    cb = circuit_breaker_instance
    cb.config.timeout_seconds = 10.0
    fake_time = [100.0]

    def fake_time_func():
        return fake_time[0]

    monkeypatch.setattr(time, "time", fake_time_func)
    cb._opened_at = 95.0
    assert cb._should_attempt_reset() is False
    fake_time[0] = 105.0
    assert cb._should_attempt_reset() is True


def test_circuit_breaker_state_transitions_to_half_open_after_timeout(monkeypatch, circuit_breaker_instance):
    """Test state property transitions from OPEN to HALF_OPEN after timeout."""
    cb = circuit_breaker_instance
    cb.config.timeout_seconds = 5.0
    fake_time = [100.0]

    def fake_time_func():
        return fake_time[0]

    monkeypatch.setattr(time, "time", fake_time_func)
    cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb.state == CircuitState.OPEN
    fake_time[0] = 106.0
    assert cb.state == CircuitState.HALF_OPEN
    assert cb._state == CircuitState.HALF_OPEN


def test_circuit_breaker_transition_to_open_sets_opened_at(monkeypatch, circuit_breaker_instance):
    """Test _transition_to OPEN sets _opened_at and increments state_transitions."""
    cb = circuit_breaker_instance
    fake_time = 123.456

    monkeypatch.setattr(time, "time", lambda: fake_time)
    cb._transition_to(CircuitState.OPEN)
    assert cb._state == CircuitState.OPEN
    assert cb._opened_at == pytest.approx(fake_time)
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


def test_circuit_breaker_transition_to_closed_resets_counts_and_window(circuit_breaker_instance):
    """Test _transition_to CLOSED resets failure_count, success_count, opened_at, and sliding window."""
    cb = circuit_breaker_instance
    cb._failure_count = 3
    cb._success_count = 2
    cb._opened_at = 123.0
    cb._sliding_window.extend([True, False])
    cb._transition_to(CircuitState.CLOSED)
    assert cb._state == CircuitState.CLOSED
    assert cb._failure_count == 0
    assert cb._success_count == 0
    assert cb._opened_at is None
    assert len(cb._sliding_window) == 0


# -----------------------------
# CircuitBreaker _allow_request tests
# -----------------------------


def test_circuit_breaker_allow_request_closed(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    assert cb._allow_request() is True


def test_circuit_breaker_allow_request_open(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.OPEN
    assert cb._allow_request() is False


def test_circuit_breaker_allow_request_half_open_within_limit(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN increments half_open_calls and allows up to max."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.half_open_max_calls = 2
    assert cb._allow_request() is True
    assert cb._half_open_calls == 1
    assert cb._allow_request() is True
    assert cb._half_open_calls == 2
    assert cb._allow_request() is False
    assert cb._half_open_calls == 2


# -----------------------------
# CircuitBreaker execute tests
# -----------------------------


def test_circuit_breaker_execute_success(circuit_breaker_instance, monkeypatch):
    """Test execute records success and returns operation result."""
    cb = circuit_breaker_instance
    operation = Mock(return_value="ok")
    monkeypatch.setattr(cb, "_allow_request", lambda: True)
    result = cb.execute(operation)
    assert result == "ok"
    assert cb.metrics.total_calls == 1
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.failed_calls == 0


def test_circuit_breaker_execute_failure_raises_and_records(circuit_breaker_instance, monkeypatch):
    """Test execute records failure and re-raises exception."""
    cb = circuit_breaker_instance

    class TestError(Exception):
        pass

    def failing_op():
        raise TestError("fail")

    monkeypatch.setattr(cb, "_allow_request", lambda: True)
    with pytest.raises(TestError):
        cb.execute(failing_op)
    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.successful_calls == 0


def test_circuit_breaker_execute_rejected_uses_fallback(circuit_breaker_instance, monkeypatch):
    """Test execute uses fallback when request is not allowed."""
    cb = circuit_breaker_instance
    monkeypatch.setattr(cb, "_allow_request", lambda: False)
    fallback = Mock(return_value="fallback")
    result = cb.execute(lambda: "should_not_run", fallback=fallback)
    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1
    fallback.assert_called_once()


def test_circuit_breaker_execute_rejected_raises_open_error(circuit_breaker_instance, monkeypatch):
    """Test execute raises CircuitBreakerOpenError when request is not allowed and no fallback."""
    cb = circuit_breaker_instance
    cb.config.timeout_seconds = 10.0
    cb._opened_at = time.time() - 5.0
    monkeypatch.setattr(cb, "_allow_request", lambda: False)
    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(lambda: "x")
    assert exc.value.name == cb.name
    assert exc.value.remaining_time >= 0.0


# -----------------------------
# CircuitBreaker _record_success tests
# -----------------------------


def test_circuit_breaker_record_success_in_closed_decrements_failure(circuit_breaker_instance):
    """Test _record_success in CLOSED decrements failure_count and updates metrics."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 3
    cb._record_success(0.2)
    assert cb._failure_count == 2
    assert cb.metrics.successful_calls == 1
    assert cb.metrics.last_success_time is not None
    assert cb.metrics.average_response_time == pytest.approx(0.2)
    assert list(cb._sliding_window) == [True]


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(circuit_breaker_instance):
    """Test _record_success in HALF_OPEN increments success_count and may close circuit."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb.config.success_threshold = 2
    cb._success_count = 0
    cb._record_success(0.1)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._success_count == 1
    cb._record_success(0.1)
    assert cb._state == CircuitState.CLOSED
    assert cb._success_count == 0
    assert cb._failure_count == 0


# -----------------------------
# CircuitBreaker _record_failure tests
# -----------------------------


def test_circuit_breaker_record_failure_in_half_open_opens(circuit_breaker_instance):
    """Test _record_failure in HALF_OPEN transitions to OPEN."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.HALF_OPEN
    cb._record_failure(0.3)
    assert cb._state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 1
    assert cb.metrics.last_failure_time is not None
    assert list(cb._sliding_window) == [False]


def test_circuit_breaker_record_failure_in_closed_uses_threshold(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens circuit when failure_threshold reached."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb.config.failure_threshold = 3
    cb._failure_count = 2
    cb._record_failure(0.1)
    assert cb._state == CircuitState.OPEN
    assert cb._failure_count == 3


def test_circuit_breaker_record_failure_in_closed_uses_failure_rate(monkeypatch):
    """Test _record_failure in CLOSED opens circuit when failure_rate_threshold reached."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # high so threshold not hit
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    cb = CircuitBreaker("svc", cfg)
    cb._state = CircuitState.CLOSED
    # Fill sliding window with 2 failures and 2 successes -> 0.5 failure rate
    cb._sliding_window.extend([False, False, True, True])
    cb._failure_count = 1
    cb._record_failure(0.1)
    assert cb._state == CircuitState.OPEN


# -----------------------------
# CircuitBreaker _calculate_failure_rate tests
# -----------------------------


def test_circuit_breaker_calculate_failure_rate_insufficient_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 when sliding window not full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 5
    cb._sliding_window.extend([False, True])
    assert cb._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate computes correct failure rate when window full."""
    cb = circuit_breaker_instance
    cb.config.sliding_window_size = 4
    cb._sliding_window = deque(maxlen=4)
    cb._sliding_window.extend([False, True, False, True])  # 2 failures / 4
    assert cb._calculate_failure_rate() == pytest.approx(0.5)


# -----------------------------
# CircuitBreaker get_health_info tests
# -----------------------------


def test_circuit_breaker_get_health_info_structure(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    cb = circuit_breaker_instance
    cb._state = CircuitState.CLOSED
    cb._failure_count = 2
    cb._success_count = 5
    cb.metrics.total_calls = 10
    cb.metrics.successful_calls = 5
    cb.metrics.failed_calls = 5
    cb.metrics.rejected_calls = 1
    cb.metrics.average_response_time = 0.123
    cb.metrics.state_transitions = 3
    cb.config.failure_threshold = 7
    cb.config.success_threshold = 4
    cb.config.timeout_seconds = 20.0

    info = cb.get_health_info()
    assert info["name"] == "test_service"
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 2
    assert info["success_count"] == 5
    assert "failure_rate" in info
    metrics = info["metrics"]
    assert metrics["total_calls"] == 10
    assert metrics["successful_calls"] == 5
    assert metrics["failed_calls"] == 5
    assert metrics["rejected_calls"] == 1
    assert metrics["average_response_time_ms"] == pytest.approx(123.0)
    assert metrics["state_transitions"] == 3
    config = info["config"]
    assert config["failure_threshold"] == 7
    assert config["success_threshold"] == 4
    assert config["timeout_seconds"] == pytest.approx(20.0)


# -----------------------------
# DistributedCircuitBreakerCoordinator tests
# -----------------------------


def test_distributed_coordinator_init_defaults(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator initialization."""
    monkeypatch.setenv("NODE_ID", "node-123")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test")
    assert coord.coordinator_url == "http://coordinator.test"
    assert coord.sync_interval == pytest.approx(5.0)
    assert coord.node_id == "node-123"
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None


def test_distributed_coordinator_register_breaker_sends_registration(coordinator_instance):
    """Test register_breaker stores breaker and calls _send_registration."""
    coord = coordinator_instance
    breaker = CircuitBreaker("svc")
    with patch.object(coord, "_send_registration") as mock_send:
        coord.register_breaker(breaker)
        assert coord._breakers["svc"] is breaker
        mock_send.assert_called_once_with(breaker)


def test_distributed_coordinator_send_registration_success(monkeypatch, coordinator_instance):
    """Test _send_registration sends HTTP POST and ignores URLError."""
    coord = coordinator_instance
    breaker = CircuitBreaker("svc")
    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)
    coord._send_registration(breaker)
    assert mock_urlopen.call_count == 1
    args, kwargs = mock_urlopen.call_args
    req = args[0]
    assert coord.coordinator_url in req.full_url
    assert req.get_method() == "POST"
    assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_send_registration_urlerror(monkeypatch, coordinator_instance):
    """Test _send_registration silently ignores URLError."""
    coord = coordinator_instance
    breaker = CircuitBreaker("svc")
    def raise_urlerror(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urlerror)
    coord._send_registration(breaker)  # should not raise


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance, monkeypatch):
    """Test start_sync starts thread and stop_sync stops it."""
    coord = coordinator_instance
    with patch.object(coord, "_sync_loop", side_effect=lambda: None) as mock_loop:
        coord.start_sync()
        assert coord._running is True
        assert isinstance(coord._sync_thread, threading.Thread)
        coord.stop_sync()
        assert coord._running is False
        mock_loop.assert_called()


def test_distributed_coordinator_sync_loop_calls_synchronize_states_once(monkeypatch):
    """Test _sync_loop calls _synchronize_states repeatedly until _running is False."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test", sync_interval=0.0)
    calls = []

    def fake_sync():
        calls.append(1)
        if len(calls) >= 3:
            coord._running = False

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)
    coord._running = True
    coord._sync_loop()
    assert len(calls) >= 3


def test_distributed_coordinator_synchronize_states_posts_state(monkeypatch, coordinator_instance):
    """Test _synchronize_states posts breaker states to coordinator."""
    coord = coordinator_instance
    breaker = CircuitBreaker("svc")
    coord._breakers["svc"] = breaker
    mock_urlopen = Mock()
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)
    coord._synchronize_states()
    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert "/circuit-breakers/state" in req.full_url
    assert req.get_method() == "POST"
    body = json.loads(req.data.decode("utf-8"))
    assert body["service"] == "svc"
    assert body["state"] == breaker.state.value
    assert "health_info" in body


def test_distributed_coordinator_synchronize_states_urlerror(monkeypatch, coordinator_instance):
    """Test _synchronize_states ignores URLError for each breaker."""
    coord = coordinator_instance
    breaker = CircuitBreaker("svc")
    coord._breakers["svc"] = breaker

    def raise_urlerror(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urlerror)
    coord._synchronize_states()  # should not raise


def test_distributed_coordinator_get_cluster_state_success(monkeypatch, coordinator_instance):
    """Test get_cluster_state returns parsed JSON on success."""
    coord = coordinator_instance
    response_data = {"state": "OK"}
    mock_response = Mock()
    mock_response.read.return_value = json.dumps(response_data).encode("utf-8")
    mock_urlopen = Mock(return_value=mock_response)
    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", mock_urlopen)
    result = coord.get_cluster_state("svc")
    assert result == response_data
    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args[0][0]
    assert "/circuit-breakers/svc/aggregate" in req.full_url
    assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror(monkeypatch, coordinator_instance):
    """Test get_cluster_state returns error dict on URLError."""
    coord = coordinator_instance

    def raise_urlerror(*args, **kwargs):
        from urllib.error import URLError
        raise URLError("fail")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", raise_urlerror)
    result = coord.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}


# -----------------------------
# circuit_breaker decorator tests
# -----------------------------


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker(monkeypatch):
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    breaker = CircuitBreaker.get_or_create("decorated")

    with patch.object(breaker, "execute", wraps=breaker.execute) as mock_execute:
        @circuit_breaker("decorated")
        def sample(x, y):
            return x + y

        assert hasattr(sample, "__wrapped__")
        assert sample.__wrapped__ is not None
        assert sample.circuit_breaker is breaker

        result = sample(2, 3)
        assert result == 5
        mock_execute.assert_called_once()
        op = mock_execute.call_args[0][0]
        assert callable(op)
        assert op() == 5
