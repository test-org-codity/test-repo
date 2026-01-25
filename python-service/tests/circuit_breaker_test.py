import json
import threading
import time
import uuid
from unittest.mock import Mock, patch

import pytest
import urllib.error

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
def reset_breaker_registry(monkeypatch):
    """Ensure CircuitBreaker registry is clean for each test."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


@pytest.fixture
def unique_name():
    """Provide a unique circuit breaker name for isolation."""
    return f"cb-{uuid.uuid4()}"


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig."""
    return CircuitBreakerConfig()


@pytest.fixture
def small_threshold_config():
    """Provide a config with small thresholds for faster tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=1.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_instance(unique_name, default_config):
    """Create a CircuitBreaker instance."""
    return CircuitBreaker.get_or_create(unique_name, default_config)


def test_circuit_state_enum_values():
    """Test CircuitState enum values are as defined."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test default configuration values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_metrics_record_response_time_updates_average():
    """Test that recording response time updates the average correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_get_or_create_singleton_per_name(unique_name):
    """Test get_or_create returns the same instance for the same name, ignoring new config."""
    cfg1 = CircuitBreakerConfig(failure_threshold=3)
    cb1 = CircuitBreaker.get_or_create(unique_name, cfg1)

    # A different config should be ignored for an existing breaker
    cfg2 = CircuitBreakerConfig(failure_threshold=10)
    cb2 = CircuitBreaker.get_or_create(unique_name, cfg2)

    assert cb1 is cb2
    assert cb1.config.failure_threshold == 3


def test_circuit_breaker_allow_request_in_closed(breaker_instance):
    """Test _allow_request returns True when state is CLOSED."""
    # Ensure breaker is in CLOSED state
    assert breaker_instance.state == CircuitState.CLOSED
    assert breaker_instance._allow_request() is True


def test_circuit_breaker_execute_success_updates_metrics(breaker_instance):
    """Test execute successful operation updates metrics and returns the result."""
    def operation():
        return "ok"

    result = breaker_instance.execute(operation)
    assert result == "ok"
    assert breaker_instance.metrics.total_calls == 1
    assert breaker_instance.metrics.successful_calls == 1
    assert breaker_instance.metrics.failed_calls == 0
    assert breaker_instance.state == CircuitState.CLOSED


def test_circuit_breaker_execute_failure_opens_after_threshold(unique_name):
    """Test that consecutive failures open the circuit after reaching failure_threshold."""
    cfg = CircuitBreakerConfig(failure_threshold=2, failure_rate_threshold=1.0)
    cb = CircuitBreaker.get_or_create(unique_name, cfg)

    def failing():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        cb.execute(failing)

    with pytest.raises(RuntimeError):
        cb.execute(failing)

    assert cb.state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 2
    assert cb.metrics.state_transitions == 1  # CLOSED -> OPEN


def test_circuit_breaker_open_rejects_calls_and_raises_without_fallback(unique_name, small_threshold_config, monkeypatch):
    """Test that when OPEN, execute rejects and raises CircuitBreakerOpenError with remaining time."""
    cb = CircuitBreaker.get_or_create(unique_name, small_threshold_config)
    cb._transition_to(CircuitState.OPEN)

    # Control time: opened_at = 100, now = 110 -> remaining = timeout - 10
    cb._opened_at = 100.0

    monkeypatch.setattr(time, "time", lambda: 110.0)

    def operation():
        pytest.fail("Operation should not be called when OPEN")

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(operation)

    assert cb.metrics.rejected_calls == 1
    # remaining = 1.0 - 10.0 -> negative, but error uses max(0, remaining)
    assert exc.value.remaining_time == pytest.approx(0.0)


def test_circuit_breaker_open_rejects_calls_and_uses_fallback(unique_name, small_threshold_config):
    """Test that when OPEN, execute uses fallback if provided."""
    cb = CircuitBreaker.get_or_create(unique_name, small_threshold_config)
    cb._transition_to(CircuitState.OPEN)

    def operation():
        pytest.fail("Operation should not be called when OPEN")

    result = cb.execute(operation, fallback=lambda: "fallback")
    assert result == "fallback"
    assert cb.metrics.rejected_calls == 1


def test_circuit_breaker_state_auto_transitions_to_half_open_after_timeout(unique_name, small_threshold_config, monkeypatch):
    """Test OPEN -> HALF_OPEN transition after timeout_seconds elapse."""
    cb = CircuitBreaker.get_or_create(unique_name, small_threshold_config)
    cb._transition_to(CircuitState.OPEN)

    # opened_at = 100, now = 101 (timeout_seconds = 1.0)
    cb._opened_at = 100.0
    monkeypatch.setattr(time, "time", lambda: 101.0)

    assert cb.state == CircuitState.HALF_OPEN
    assert cb.metrics.state_transitions == 2  # CLOSED -> OPEN -> HALF_OPEN


def test_circuit_breaker_half_open_allows_limited_calls(unique_name):
    """Test HALF_OPEN allows up to half_open_max_calls and then rejects."""
    cfg = CircuitBreakerConfig(half_open_max_calls=2)
    cb = CircuitBreaker.get_or_create(unique_name, cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    assert cb._allow_request() is True
    assert cb._allow_request() is True
    assert cb._allow_request() is False
    assert cb._half_open_calls == 2


def test_circuit_breaker_half_open_success_threshold_closes(unique_name):
    """Test that reaching success_threshold in HALF_OPEN transitions to CLOSED."""
    cfg = CircuitBreakerConfig(success_threshold=2)
    cb = CircuitBreaker.get_or_create(unique_name, cfg)
    cb._transition_to(CircuitState.HALF_OPEN)

    cb._record_success(0.05)
    assert cb.state == CircuitState.HALF_OPEN  # not yet

    cb._record_success(0.05)
    assert cb.state == CircuitState.CLOSED
    assert cb.metrics.state_transitions >= 2  # at least CLOSED -> HALF_OPEN -> CLOSED


def test_circuit_breaker_half_open_failure_reopens(unique_name):
    """Test that any failure in HALF_OPEN re-opens the circuit."""
    cb = CircuitBreaker.get_or_create(unique_name)
    cb._transition_to(CircuitState.HALF_OPEN)

    cb._record_failure(0.05)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_window_not_full_returns_zero(unique_name):
    """Test that failure rate is 0.0 until the sliding window is full."""
    cfg = CircuitBreakerConfig(sliding_window_size=4)
    cb = CircuitBreaker.get_or_create(unique_name, cfg)

    cb._record_failure(0.01)
    cb._record_success(0.01)
    cb._record_success(0.01)

    assert cb._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_triggers_open_when_threshold_exceeded(unique_name):
    """Test that failure rate threshold opens the circuit when the window is full."""
    cfg = CircuitBreakerConfig(
        sliding_window_size=4,
        failure_rate_threshold=0.5,
        failure_threshold=999  # avoid open by count
    )
    cb = CircuitBreaker.get_or_create(unique_name, cfg)

    # Fill window: True, False, True -> then a failure to complete full window and trigger rate check
    cb._record_success(0.01)
    cb._record_failure(0.01)
    cb._record_success(0.01)
    cb._record_failure(0.01)  # Now window is full: 2 failures / 4 = 0.5 -> OPEN

    assert cb.state == CircuitState.OPEN
    # Health info reports failure_rate
    health = cb.get_health_info()
    assert health["failure_rate"] == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_contains_expected_keys(breaker_instance):
    """Test get_health_info returns keys and computed average response time in ms."""
    # Manually record a response time to control average
    breaker_instance.metrics.record_response_time(0.25)  # seconds
    info = breaker_instance.get_health_info()

    assert info["name"] == breaker_instance.name
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert "failure_count" in info
    assert "success_count" in info
    assert "failure_rate" in info
    assert "metrics" in info
    assert "config" in info

    assert info["metrics"]["average_response_time_ms"] == pytest.approx(250.0)


def test_distributed_coordinator_register_breaker_sends_registration(unique_name):
    """Test register_breaker sends registration POST with expected payload."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example")
    cb = CircuitBreaker.get_or_create(unique_name)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_resp = Mock()
        mock_urlopen.return_value = mock_resp

        coord.register_breaker(cb)

        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args.args[0]
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"
        payload = json.loads(req.data.decode("utf-8"))
        assert payload["service"] == cb.name
        assert "node_id" in payload
        assert payload["failure_threshold"] == cb.config.failure_threshold
        assert payload["success_threshold"] == cb.config.success_threshold


def test_distributed_coordinator_synchronize_states_posts_state(unique_name):
    """Test _synchronize_states posts breaker state and health info."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example")
    cb = CircuitBreaker.get_or_create(unique_name)
    coord.register_breaker(cb)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_resp = Mock()
        mock_urlopen.return_value = mock_resp

        coord._synchronize_states()

        assert mock_urlopen.call_count >= 1
        req = mock_urlopen.call_args.args[0]
        assert req.full_url.endswith("/circuit-breakers/state")
        assert req.get_method() == "POST"
        data = json.loads(req.data.decode("utf-8"))
        assert data["service"] == cb.name
        assert data["state"] == cb.state.value
        assert data["failure_count"] == cb._failure_count
        assert isinstance(data["timestamp"], int)
        assert isinstance(data["health_info"], dict)


def test_distributed_coordinator_start_and_stop_sync_calls_synchronize_states(unique_name, monkeypatch):
    """Test start_sync starts thread that invokes _synchronize_states; stop_sync stops it."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example", sync_interval=0.01)
    cb = CircuitBreaker.get_or_create(unique_name)
    coord.register_breaker(cb)

    call_counter = {"count": 0}

    def sync_mock():
        call_counter["count"] += 1

    monkeypatch.setattr(coord, "_synchronize_states", sync_mock)

    coord.start_sync()
    time.sleep(0.05)
    coord.stop_sync()

    assert call_counter["count"] >= 1


def test_distributed_coordinator_get_cluster_state_success_and_error(unique_name):
    """Test get_cluster_state returns parsed JSON on success and error dict on URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example")

    # Success path
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        resp = Mock()
        resp.read.return_value = b'{"cluster":"ok"}'
        mock_urlopen.return_value = resp

        result = coord.get_cluster_state("service-a")
        assert result == {"cluster": "ok"}

    # Error path
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("fail")):
        result = coord.get_cluster_state("service-a")
        assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_open_error_remaining_time_calculation(unique_name, monkeypatch):
    """Test CircuitBreakerOpenError remaining_time is non-negative and message includes name."""
    cfg = CircuitBreakerConfig(timeout_seconds=5.0)
    cb = CircuitBreaker.get_or_create(unique_name, cfg)
    cb._transition_to(CircuitState.OPEN)
    cb._opened_at = 100.0
    monkeypatch.setattr(time, "time", lambda: 102.0)

    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb.execute(lambda: None)

    assert exc.value.name == cb.name
    # remaining = 5 - 2 = 3
    assert exc.value.remaining_time == pytest.approx(3.0)
    assert cb.name in str(exc.value)


def test_decorator_circuit_breaker_wraps_function_and_uses_same_instance(unique_name):
    """Test circuit_breaker decorator wraps function and uses the same CircuitBreaker instance."""
    cfg = CircuitBreakerConfig(failure_threshold=3)
    dec = circuit_breaker(unique_name, cfg)

    called = {"count": 0}

    @dec
    def sample(x):
        called["count"] += 1
        return x * 2

    # wrapper should have circuit_breaker attribute
    assert hasattr(sample, "circuit_breaker")
    same_instance = CircuitBreaker.get_or_create(unique_name)
    assert sample.circuit_breaker is same_instance

    result = sample(5)
    assert result == 10
    assert called["count"] == 1
    assert same_instance.metrics.total_calls == 1
    assert same_instance.metrics.successful_calls == 1