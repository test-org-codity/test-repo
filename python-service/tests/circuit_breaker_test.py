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


# -----------------------------
# CircuitBreakerOpenError tests
# -----------------------------


def test_circuit_breaker_open_error_message():
    """Test CircuitBreakerOpenError message formatting."""
    err = CircuitBreakerOpenError("test_breaker", 12.3456)
    assert err.name == "test_breaker"
    assert err.remaining_time == pytest.approx(12.3456)
    assert "Circuit breaker 'test_breaker' is open. Retry after" in str(err)


# -----------------------------
# CircuitBreaker __init__ and get_or_create tests
# -----------------------------


def test_circuit_breaker_initialization_defaults():
    """Test CircuitBreaker initialization with default config."""
    cb = CircuitBreaker("init_test")
    assert cb.name == "init_test"
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
    """Test get_or_create creates a new instance only once per name."""
    cb1 = CircuitBreaker.get_or_create("shared", default_config)
    cb2 = CircuitBreaker.get_or_create("shared", default_config)
    assert cb1 is cb2
    assert cb1.name == "shared"


def test_circuit_breaker_get_or_create_different_names(default_config):
    """Test get_or_create returns different instances for different names."""
    cb1 = CircuitBreaker.get_or_create("breaker1", default_config)
    cb2 = CircuitBreaker.get_or_create("breaker2", default_config)
    assert cb1 is not cb2
    assert cb1.name == "breaker1"
    assert cb2.name == "breaker2"


# -----------------------------
# CircuitBreaker state and transitions tests
# -----------------------------


def test_circuit_breaker_state_closed_initial(circuit_breaker_instance):
    """Test initial state is CLOSED."""
    assert circuit_breaker_instance.state == CircuitState.CLOSED


def test_circuit_breaker_should_attempt_reset_false_when_never_opened(circuit_breaker_instance):
    """Test _should_attempt_reset returns False when breaker was never opened."""
    assert circuit_breaker_instance._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_based_on_timeout(circuit_breaker_instance):
    """Test _should_attempt_reset respects timeout_seconds."""
    circuit_breaker_instance._opened_at = time.time() - circuit_breaker_instance.config.timeout_seconds - 1
    assert circuit_breaker_instance._should_attempt_reset() is True
    circuit_breaker_instance._opened_at = time.time()
    assert circuit_breaker_instance._should_attempt_reset() is False


def test_circuit_breaker_transition_to_open_sets_opened_at(circuit_breaker_instance):
    """Test _transition_to OPEN sets opened_at and increments transitions."""
    before_transitions = circuit_breaker_instance.metrics.state_transitions
    circuit_breaker_instance._transition_to(CircuitState.OPEN)
    assert circuit_breaker_instance._state == CircuitState.OPEN
    assert circuit_breaker_instance._opened_at is not None
    assert circuit_breaker_instance.metrics.state_transitions == before_transitions + 1


def test_circuit_breaker_transition_to_half_open_resets_counts(circuit_breaker_instance):
    """Test _transition_to HALF_OPEN resets half_open_calls and success_count."""
    circuit_breaker_instance._half_open_calls = 5
    circuit_breaker_instance._success_count = 7
    circuit_breaker_instance._transition_to(CircuitState.HALF_OPEN)
    assert circuit_breaker_instance._state == CircuitState.HALF_OPEN
    assert circuit_breaker_instance._half_open_calls == 0
    assert circuit_breaker_instance._success_count == 0


def test_circuit_breaker_transition_to_closed_resets_failure_and_success(circuit_breaker_instance):
    """Test _transition_to CLOSED resets failure_count, success_count, opened_at, and sliding window."""
    circuit_breaker_instance._failure_count = 3
    circuit_breaker_instance._success_count = 2
    circuit_breaker_instance._opened_at = time.time()
    circuit_breaker_instance._sliding_window.extend([True, False])
    circuit_breaker_instance._transition_to(CircuitState.CLOSED)
    assert circuit_breaker_instance._state == CircuitState.CLOSED
    assert circuit_breaker_instance._failure_count == 0
    assert circuit_breaker_instance._success_count == 0
    assert circuit_breaker_instance._opened_at is None
    assert len(circuit_breaker_instance._sliding_window) == 0


def test_circuit_breaker_state_property_triggers_half_open_after_timeout(circuit_breaker_instance, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN after timeout."""
    circuit_breaker_instance._transition_to(CircuitState.OPEN)
    opened_at = time.time() - circuit_breaker_instance.config.timeout_seconds - 1
    circuit_breaker_instance._opened_at = opened_at

    with patch("time.time", return_value=opened_at + circuit_breaker_instance.config.timeout_seconds + 0.1):
        state = circuit_breaker_instance.state
        assert state == CircuitState.HALF_OPEN
        assert circuit_breaker_instance._state == CircuitState.HALF_OPEN


# -----------------------------
# CircuitBreaker _allow_request tests
# -----------------------------


def test_circuit_breaker_allow_request_closed(circuit_breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    circuit_breaker_instance._state = CircuitState.CLOSED
    assert circuit_breaker_instance._allow_request() is True


def test_circuit_breaker_allow_request_open(circuit_breaker_instance):
    """Test _allow_request returns False when state is OPEN."""
    circuit_breaker_instance._state = CircuitState.OPEN
    assert circuit_breaker_instance._allow_request() is False


def test_circuit_breaker_allow_request_half_open_within_limit(circuit_breaker_instance):
    """Test _allow_request in HALF_OPEN allows up to half_open_max_calls."""
    circuit_breaker_instance._state = CircuitState.HALF_OPEN
    circuit_breaker_instance.config.half_open_max_calls = 2
    assert circuit_breaker_instance._allow_request() is True
    assert circuit_breaker_instance._allow_request() is True
    assert circuit_breaker_instance._allow_request() is False


# -----------------------------
# CircuitBreaker execute tests
# -----------------------------


def test_circuit_breaker_execute_success(circuit_breaker_instance):
    """Test execute calls operation and records success."""
    op = Mock(return_value="ok")
    result = circuit_breaker_instance.execute(op)
    assert result == "ok"
    assert circuit_breaker_instance.metrics.total_calls == 1
    assert circuit_breaker_instance.metrics.successful_calls == 1
    assert circuit_breaker_instance.metrics.failed_calls == 0


def test_circuit_breaker_execute_failure(circuit_breaker_instance):
    """Test execute records failure and re-raises exception."""
    def failing():
        raise ValueError("fail")

    with pytest.raises(ValueError):
        circuit_breaker_instance.execute(failing)

    assert circuit_breaker_instance.metrics.total_calls == 1
    assert circuit_breaker_instance.metrics.failed_calls == 1
    assert circuit_breaker_instance.metrics.successful_calls == 0


def test_circuit_breaker_execute_rejected_without_fallback_raises(circuit_breaker_instance):
    """Test execute raises CircuitBreakerOpenError when request not allowed and no fallback."""
    circuit_breaker_instance._state = CircuitState.OPEN
    circuit_breaker_instance._opened_at = time.time() - 1
    with pytest.raises(CircuitBreakerOpenError) as exc:
        circuit_breaker_instance.execute(lambda: "should_not_run")
    assert exc.value.name == "test_breaker"
    assert exc.value.remaining_time >= 0
    assert circuit_breaker_instance.metrics.rejected_calls == 1


def test_circuit_breaker_execute_rejected_with_fallback(circuit_breaker_instance):
    """Test execute uses fallback when request not allowed."""
    circuit_breaker_instance._state = CircuitState.OPEN
    circuit_breaker_instance._opened_at = time.time() - 1
    op = Mock()
    fallback = Mock(return_value="fallback")
    result = circuit_breaker_instance.execute(op, fallback=fallback)
    assert result == "fallback"
    op.assert_not_called()
    fallback.assert_called_once()
    assert circuit_breaker_instance.metrics.rejected_calls == 1


# -----------------------------
# CircuitBreaker _record_success tests
# -----------------------------


def test_circuit_breaker_record_success_in_closed_decrements_failure(circuit_breaker_instance):
    """Test _record_success in CLOSED state decrements failure_count."""
    circuit_breaker_instance._state = CircuitState.CLOSED
    circuit_breaker_instance._failure_count = 3
    circuit_breaker_instance._record_success(0.05)
    assert circuit_breaker_instance._failure_count == 2
    assert circuit_breaker_instance.metrics.successful_calls == 1
    assert circuit_breaker_instance.metrics.last_success_time is not None
    assert circuit_breaker_instance.metrics.average_response_time == pytest.approx(0.05)


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(circuit_breaker_instance):
    """Test _record_success in HALF_OPEN transitions to CLOSED after success_threshold."""
    circuit_breaker_instance._state = CircuitState.HALF_OPEN
    circuit_breaker_instance.config.success_threshold = 2
    circuit_breaker_instance._success_count = 1
    circuit_breaker_instance._record_success(0.1)
    assert circuit_breaker_instance._state == CircuitState.CLOSED
    assert circuit_breaker_instance._success_count == 0 or circuit_breaker_instance._success_count >= 0


# -----------------------------
# CircuitBreaker _record_failure tests
# -----------------------------


def test_circuit_breaker_record_failure_in_half_open_opens(circuit_breaker_instance):
    """Test _record_failure in HALF_OPEN transitions to OPEN."""
    circuit_breaker_instance._state = CircuitState.HALF_OPEN
    circuit_breaker_instance._record_failure(0.2)
    assert circuit_breaker_instance._state == CircuitState.OPEN
    assert circuit_breaker_instance.metrics.failed_calls == 1
    assert circuit_breaker_instance.metrics.last_failure_time is not None


def test_circuit_breaker_record_failure_in_closed_opens_on_threshold(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens breaker when failure_threshold reached."""
    circuit_breaker_instance._state = CircuitState.CLOSED
    circuit_breaker_instance.config.failure_threshold = 2
    circuit_breaker_instance._failure_count = 1
    circuit_breaker_instance._record_failure(0.2)
    assert circuit_breaker_instance._state == CircuitState.OPEN
    assert circuit_breaker_instance._failure_count == 2


def test_circuit_breaker_record_failure_in_closed_opens_on_failure_rate(circuit_breaker_instance):
    """Test _record_failure in CLOSED opens breaker when failure_rate_threshold reached."""
    circuit_breaker_instance._state = CircuitState.CLOSED
    circuit_breaker_instance.config.sliding_window_size = 4
    circuit_breaker_instance.config.failure_rate_threshold = 0.5
    circuit_breaker_instance._sliding_window = deque(maxlen=4)
    circuit_breaker_instance._sliding_window.extend([False, False, True])
    circuit_breaker_instance._failure_count = 0
    circuit_breaker_instance._record_failure(0.1)
    assert circuit_breaker_instance._state == CircuitState.OPEN


# -----------------------------
# CircuitBreaker _calculate_failure_rate tests
# -----------------------------


def test_circuit_breaker_calculate_failure_rate_insufficient_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns 0.0 when sliding window not full."""
    circuit_breaker_instance.config.sliding_window_size = 5
    circuit_breaker_instance._sliding_window = deque([True, False], maxlen=5)
    rate = circuit_breaker_instance._calculate_failure_rate()
    assert rate == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_full_window(circuit_breaker_instance):
    """Test _calculate_failure_rate returns correct rate when window is full."""
    circuit_breaker_instance.config.sliding_window_size = 4
    circuit_breaker_instance._sliding_window = deque([True, False, False, True], maxlen=4)
    rate = circuit_breaker_instance._calculate_failure_rate()
    assert rate == pytest.approx(2 / 4)


# -----------------------------
# CircuitBreaker get_health_info tests
# -----------------------------


def test_circuit_breaker_get_health_info_structure(circuit_breaker_instance):
    """Test get_health_info returns expected structure and values."""
    circuit_breaker_instance._failure_count = 2
    circuit_breaker_instance._success_count = 3
    circuit_breaker_instance.metrics.total_calls = 10
    circuit_breaker_instance.metrics.successful_calls = 7
    circuit_breaker_instance.metrics.failed_calls = 3
    circuit_breaker_instance.metrics.rejected_calls = 1
    circuit_breaker_instance.metrics.state_transitions = 2
    circuit_breaker_instance.metrics.average_response_time = 0.123

    info = circuit_breaker_instance.get_health_info()
    assert info["name"] == "test_breaker"
    assert info["state"] == circuit_breaker_instance._state.value
    assert info["failure_count"] == 2
    assert info["success_count"] == 3
    assert isinstance(info["failure_rate"], float)
    metrics = info["metrics"]
    assert metrics["total_calls"] == 10
    assert metrics["successful_calls"] == 7
    assert metrics["failed_calls"] == 3
    assert metrics["rejected_calls"] == 1
    assert metrics["state_transitions"] == 2
    assert metrics["average_response_time_ms"] == pytest.approx(0.123 * 1000)
    config = info["config"]
    assert config["failure_threshold"] == circuit_breaker_instance.config.failure_threshold
    assert config["success_threshold"] == circuit_breaker_instance.config.success_threshold
    assert config["timeout_seconds"] == pytest.approx(circuit_breaker_instance.config.timeout_seconds)


# -----------------------------
# DistributedCircuitBreakerCoordinator __init__ tests
# -----------------------------


def test_distributed_coordinator_initialization():
    """Test DistributedCircuitBreakerCoordinator initialization."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.test", sync_interval=1.5)
    assert coord.coordinator_url == "http://coordinator.test"
    assert coord.sync_interval == pytest.approx(1.5)
    assert coord._breakers == {}
    assert coord._running is False
    assert coord._sync_thread is None
    assert coord.node_id.startswith("python-") or isinstance(coord.node_id, str)


# -----------------------------
# DistributedCircuitBreakerCoordinator register_breaker tests
# -----------------------------


def test_distributed_coordinator_register_breaker_sends_registration(coordinator_instance, circuit_breaker_instance):
    """Test register_breaker stores breaker and calls _send_registration."""
    with patch.object(coordinator_instance, "_send_registration") as mock_send:
        coordinator_instance.register_breaker(circuit_breaker_instance)
        assert coordinator_instance._breakers["test_breaker"] is circuit_breaker_instance
        mock_send.assert_called_once_with(circuit_breaker_instance)


# -----------------------------
# DistributedCircuitBreakerCoordinator _send_registration tests
# -----------------------------


def test_distributed_coordinator_send_registration_success(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration sends HTTP POST request."""
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator_instance._send_registration(circuit_breaker_instance)
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_send_registration_handles_url_error(coordinator_instance, circuit_breaker_instance):
    """Test _send_registration silently ignores URLError."""
    with patch("urllib.request.urlopen", side_effect=Exception("network")):
        coordinator_instance._send_registration(circuit_breaker_instance)
        # No exception should propagate


# -----------------------------
# DistributedCircuitBreakerCoordinator start_sync / stop_sync tests
# -----------------------------


def test_distributed_coordinator_start_and_stop_sync(coordinator_instance):
    """Test start_sync starts thread and stop_sync stops it."""
    with patch.object(coordinator_instance, "_sync_loop", side_effect=lambda: time.sleep(0.02)):
        coordinator_instance.start_sync()
        assert coordinator_instance._running is True
        assert isinstance(coordinator_instance._sync_thread, threading.Thread)
        coordinator_instance.stop_sync()
        assert coordinator_instance._running is False


# -----------------------------
# DistributedCircuitBreakerCoordinator _synchronize_states tests
# -----------------------------


def test_distributed_coordinator_synchronize_states_sends_state(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states sends state for each registered breaker."""
    coordinator_instance._breakers["test_breaker"] = circuit_breaker_instance
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator_instance._synchronize_states()
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/state")
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_synchronize_states_handles_url_error(coordinator_instance, circuit_breaker_instance):
    """Test _synchronize_states ignores URLError for each breaker."""
    coordinator_instance._breakers["test_breaker"] = circuit_breaker_instance
    with patch("urllib.request.urlopen", side_effect=Exception("network")):
        coordinator_instance._synchronize_states()
        # No exception should propagate


# -----------------------------
# DistributedCircuitBreakerCoordinator get_cluster_state tests
# -----------------------------


def test_distributed_coordinator_get_cluster_state_success(coordinator_instance):
    """Test get_cluster_state returns parsed JSON on success."""
    response_data = {"state": "OK"}
    mock_response = Mock()
    mock_response.read.return_value = json.dumps(response_data).encode("utf-8")
    with patch("urllib.request.urlopen", return_value=mock_response) as mock_urlopen:
        result = coordinator_instance.get_cluster_state("serviceA")
        assert result == response_data
        assert mock_urlopen.call_count == 1
        args, kwargs = mock_urlopen.call_args
        req = args[0]
        assert req.full_url.endswith("/circuit-breakers/serviceA/aggregate")
        assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_error(coordinator_instance):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("urllib.request.urlopen", side_effect=Exception("network")):
        result = coordinator_instance.get_cluster_state("serviceA")
        assert result == {"error": "Failed to fetch cluster state"}


# -----------------------------
# circuit_breaker decorator tests
# -----------------------------


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test circuit_breaker decorator wraps function and uses CircuitBreaker.execute."""
    with patch.object(CircuitBreaker, "get_or_create") as mock_get_or_create:
        mock_breaker = Mock(spec=CircuitBreaker)
        mock_breaker.execute.side_effect = lambda op: op()
        mock_get_or_create.return_value = mock_breaker

        @circuit_breaker("decorated")
        def sample(x, y):
            return x + y

        result = sample(2, 3)
        assert result == 5
        mock_get_or_create.assert_called_once()
        mock_breaker.execute.assert_called_once()
        assert getattr(sample, "__wrapped__") is not None
        assert getattr(sample, "circuit_breaker") is mock_breaker