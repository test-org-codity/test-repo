import json
import time
import threading
import pytest
from unittest.mock import Mock, patch
from urllib.error import URLError

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
def reset_registry(monkeypatch):
    """Reset CircuitBreaker registry before each test to avoid cross-test interference."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


@pytest.fixture
def config():
    """Provide a CircuitBreakerConfig with small timeouts for testing."""
    return CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=0.05,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator with a dummy URL."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://example.com", sync_interval=0.01)


def test_circuit_state_values():
    """Test CircuitState enum values."""
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
    """Test that record_response_time updates average_response_time correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    assert metrics.average_response_time == pytest.approx(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3) / 2)


def test_circuit_breaker_open_error_message_and_attributes():
    """Test CircuitBreakerOpenError formatting and attributes."""
    err = CircuitBreakerOpenError("service-x", 1.2345)
    assert err.name == "service-x"
    assert err.remaining_time == pytest.approx(1.2345)
    assert str(err) == "Circuit breaker 'service-x' is open. Retry after 1.23s"


def test_circuit_breaker_get_or_create_singleton():
    """Test get_or_create returns the same instance for the same name."""
    cb1 = CircuitBreaker.get_or_create("svc")
    cb2 = CircuitBreaker.get_or_create("svc")
    cb3 = CircuitBreaker.get_or_create("svc2")
    assert cb1 is cb2
    assert cb1 is not cb3


def test_circuit_breaker_state_transitions_to_half_open_after_timeout(breaker, monkeypatch):
    """Test that state transitions from OPEN to HALF_OPEN after timeout when accessed."""
    breaker._transition_to(CircuitState.OPEN)
    now = time.time()
    breaker._opened_at = now - breaker.config.timeout_seconds - 0.01
    assert breaker.state == CircuitState.HALF_OPEN


def test_circuit_breaker_should_attempt_reset_false_without_opened_at(breaker):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_transition_to_closed_resets_counters_and_window(breaker):
    """Test _transition_to CLOSED resets internal counters and window."""
    breaker._failure_count = 5
    breaker._success_count = 2
    breaker._opened_at = time.time()
    breaker._sliding_window.extend([True, False, True])
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.state == CircuitState.CLOSED


def test_circuit_breaker_execute_success_updates_metrics_and_returns(breaker):
    """Test execute on a successful operation updates metrics and returns result."""
    def op():
        return 42

    result = breaker.execute(op)
    assert result == 42
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time >= 0.0


def test_circuit_breaker_execute_failure_records_and_raises():
    """Test execute on a failing operation records failure and eventually opens circuit based on threshold."""
    cfg = CircuitBreakerConfig(failure_threshold=1, timeout_seconds=0.05)
    cb = CircuitBreaker("fail-breaker", cfg)

    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        cb.execute(failing)
    assert cb.metrics.total_calls == 1
    assert cb.metrics.failed_calls == 1
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_execute_open_with_fallback_returns_value_and_records_rejected(breaker):
    """Test that when circuit is OPEN and fallback is provided, fallback is used and rejected_calls incremented."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time()
    def op():
        return "primary"

    result = breaker.execute(op, fallback=lambda: "fallback")
    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1


def test_circuit_breaker_execute_open_without_fallback_raises_open_error_with_remaining_time(breaker, monkeypatch):
    """Test open breaker without fallback raises CircuitBreakerOpenError with correct remaining time."""
    breaker._transition_to(CircuitState.OPEN)
    now = time.time()
    # Set opened_at so that remaining time is approx 0.02
    breaker._opened_at = now - (breaker.config.timeout_seconds - 0.02)

    def op():
        return "should not run"

    with pytest.raises(CircuitBreakerOpenError) as exc:
        breaker.execute(op)
    err = exc.value
    assert err.name == breaker.name
    assert err.remaining_time == pytest.approx(0.02, rel=1e-2, abs=0.02)


def test_circuit_breaker_allow_request_half_open_respects_max_calls(breaker):
    """Test HALF_OPEN allows up to half_open_max_calls then rejects further calls."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._allow_request() is True
    assert breaker._allow_request() is True
    assert breaker._allow_request() is False


def test_circuit_breaker_record_success_in_half_open_transitions_to_closed(breaker):
    """Test that enough successes in HALF_OPEN transitions breaker to CLOSED."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_success(0.01)
    assert breaker.state == CircuitState.HALF_OPEN
    breaker._record_success(0.01)
    assert breaker.state == CircuitState.CLOSED


def test_circuit_breaker_record_success_in_closed_decrements_failure_count_not_below_zero(breaker):
    """Test that _record_success in CLOSED decrements failure_count but not below zero."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._failure_count = 2
    breaker._record_success(0.01)
    assert breaker._failure_count == 1
    breaker._record_success(0.01)
    assert breaker._failure_count == 0
    breaker._record_success(0.01)
    assert breaker._failure_count == 0


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker):
    """Test that a failure in HALF_OPEN transitions breaker back to OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_failure(0.02)
    assert breaker.state == CircuitState.OPEN


def test_circuit_breaker_failure_rate_trips_open_when_window_full():
    """Test that failure rate threshold can trip breaker to OPEN when sliding window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,
        timeout_seconds=0.05,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    cb = CircuitBreaker("rate-breaker", cfg)
    cb._transition_to(CircuitState.CLOSED)
    cb._record_failure(0.01)
    assert cb.state == CircuitState.CLOSED  # window not full yet
    cb._record_failure(0.01)
    assert cb.state == CircuitState.CLOSED
    cb._record_failure(0.01)
    assert cb.state == CircuitState.CLOSED
    cb._record_failure(0.01)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_before_window_full_returns_zero(breaker):
    """Test _calculate_failure_rate returns 0.0 until the sliding window is full."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._record_failure(0.01)
    breaker._record_success(0.01)
    breaker._record_failure(0.01)
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_when_window_full(breaker):
    """Test _calculate_failure_rate when window is full returns correct failure rate."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._record_failure(0.01)
    breaker._record_success(0.01)
    breaker._record_failure(0.01)
    breaker._record_success(0.01)
    # Now window size is 4; 2 failures of 4 -> 0.5
    assert breaker._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_fields(breaker):
    """Test get_health_info returns expected structure and values."""
    # Perform some calls
    breaker._transition_to(CircuitState.CLOSED)
    breaker._record_success(0.01)
    breaker._record_failure(0.02)

    info = breaker.get_health_info()
    assert info["name"] == breaker.name
    assert info["state"] == breaker.state.value
    assert info["failure_count"] == breaker._failure_count
    assert info["success_count"] == breaker._success_count
    assert "metrics" in info
    assert "config" in info
    assert info["metrics"]["total_calls"] == breaker.metrics.total_calls
    assert info["metrics"]["successful_calls"] == breaker.metrics.successful_calls
    assert info["metrics"]["failed_calls"] == breaker.metrics.failed_calls
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(
        breaker.metrics.average_response_time * 1000
    )


def test_coordinator_register_breaker_sends_registration(coordinator, breaker):
    """Test register_breaker sends a POST to registration endpoint with correct payload."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_response = Mock()
        mock_urlopen.return_value = mock_response

        coordinator.register_breaker(breaker)

        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert req.full_url == "http://example.com/circuit-breakers/register"
        assert req.get_method() == "POST"
        data = json.loads(req.data.decode("utf-8"))
        assert data["service"] == breaker.name
        assert "failure_threshold" in data
        assert "success_threshold" in data


def test_coordinator_send_registration_handles_urlerror(coordinator, breaker):
    """Test _send_registration handles URLError without raising."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("fail")):
        # Should not raise
        coordinator.register_breaker(breaker)


def test_coordinator_synchronize_states_posts_state_for_each_breaker(coordinator, breaker):
    """Test _synchronize_states posts current state for each registered breaker."""
    breaker2 = CircuitBreaker("another", breaker.config)
    coordinator.register_breaker(breaker)
    coordinator.register_breaker(breaker2)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_response = Mock()
        mock_urlopen.return_value = mock_response

        coordinator._synchronize_states()

        # Expect two calls, one per breaker
        assert mock_urlopen.call_count == 2
        called_urls = [call_args[0][0].full_url for call_args in mock_urlopen.call_args_list]
        assert all(url.endswith("/circuit-breakers/state") for url in called_urls)

        # Verify payload of first call
        req0 = mock_urlopen.call_args_list[0][0][0]
        payload0 = json.loads(req0.data.decode("utf-8"))
        assert "service" in payload0
        assert "state" in payload0
        assert payload0["state"] in [CircuitState.CLOSED.value, CircuitState.OPEN.value, CircuitState.HALF_OPEN.value]
        assert "health_info" in payload0


def test_coordinator_start_and_stop_sync_calls_synchronize_periodically(coordinator, breaker, monkeypatch):
    """Test start_sync and stop_sync manage background synchronization loop."""
    coordinator.register_breaker(breaker)
    sync_mock = Mock()
    monkeypatch.setattr(coordinator, "_synchronize_states", sync_mock)

    coordinator.start_sync()
    time.sleep(0.05)
    coordinator.stop_sync()

    assert sync_mock.call_count >= 2


def test_coordinator_get_cluster_state_success(coordinator):
    """Test get_cluster_state performs GET and parses JSON on success."""
    expected = {"aggregate": "ok", "state": "CLOSED"}

    class DummyResponse:
        def read(self):
            return json.dumps(expected).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=DummyResponse()) as mock_urlopen:
        result = coordinator.get_cluster_state("svc")
        assert result == expected
        req = mock_urlopen.call_args[0][0]
        assert req.full_url == "http://example.com/circuit-breakers/svc/aggregate"
        assert req.get_method() == "GET"


def test_coordinator_get_cluster_state_handles_urlerror(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")):
        result = coordinator.get_cluster_state("svc")
        assert result == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_executes_with_shared_breaker(monkeypatch):
    """Test circuit_breaker decorator uses shared breaker and executes wrapped function."""
    cfg = CircuitBreakerConfig(failure_threshold=2, success_threshold=1, timeout_seconds=0.01)
    decorated_calls = []

    @circuit_breaker("decorated", cfg)
    def my_func(x):
        decorated_calls.append(x)
        return x * 2

    result = my_func(3)
    assert result == 6
    assert decorated_calls == [3]
    # Access breaker from wrapper
    br = my_func.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    assert br.metrics.successful_calls == 1