import json
import threading
import time
import urllib.error
import pytest
from unittest.mock import Mock, patch

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
def reset_registry():
    """Reset the CircuitBreaker registry before and after each test for isolation."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def basic_config():
    """Provide a basic CircuitBreakerConfig with small thresholds for tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.5,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(basic_config):
    """Create a CircuitBreaker instance for tests."""
    return CircuitBreaker.get_or_create("test-service", basic_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator with a short sync interval."""
    return DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)


def test_circuit_state_values():
    """Test CircuitState enum values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test default values of CircuitBreakerConfig."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test that CircuitBreakerMetrics averages response times correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    assert metrics.average_response_time == pytest.approx(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_open_error_fields_and_message():
    """Test CircuitBreakerOpenError fields and message formatting."""
    err = CircuitBreakerOpenError("alpha", 1.23456)
    assert err.name == "alpha"
    assert err.remaining_time == pytest.approx(1.23456)
    assert "Circuit breaker 'alpha' is open" in str(err)
    assert "Retry after" in str(err)


def test_circuit_breaker_get_or_create_singleton_behavior():
    """Test get_or_create returns a singleton per name and retains initial config."""
    cfg1 = CircuitBreakerConfig(failure_threshold=7)
    cfg2 = CircuitBreakerConfig(failure_threshold=3)
    br1 = CircuitBreaker.get_or_create("svc", cfg1)
    br2 = CircuitBreaker.get_or_create("svc", cfg2)
    assert br1 is br2
    # Should keep the first config used to create the instance
    assert br2.config.failure_threshold == 7


def test_circuit_breaker_state_open_to_half_open_on_timeout(basic_config, monkeypatch):
    """Test that state transitions from OPEN to HALF_OPEN after timeout via state property."""
    cb = CircuitBreaker.get_or_create("svc-timeout", basic_config)

    current = [100.0]

    def fake_time():
        return current[0]

    monkeypatch.setattr("src.circuit_breaker.time.time", fake_time)
    # Transition to OPEN to set _opened_at
    cb._transition_to(CircuitState.OPEN)
    assert cb.state == CircuitState.OPEN

    # Before timeout, state remains OPEN
    current[0] = 100.0 + basic_config.timeout_seconds - 0.1
    assert cb.state == CircuitState.OPEN

    # After timeout, state property should transition to HALF_OPEN
    current[0] = 100.0 + basic_config.timeout_seconds + 0.01
    assert cb.state == CircuitState.HALF_OPEN
    assert cb._half_open_calls == 0
    assert cb._success_count == 0


def test_circuit_breaker_should_attempt_reset(breaker, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout and when opened_at is set."""
    current = [50.0]

    def fake_time():
        return current[0]

    monkeypatch.setattr("src.circuit_breaker.time.time", fake_time)
    # Initially not opened
    assert breaker._should_attempt_reset() is False

    breaker._transition_to(CircuitState.OPEN)
    # Not yet reached timeout
    current[0] += breaker.config.timeout_seconds - 0.01
    assert breaker._should_attempt_reset() is False
    # After timeout
    current[0] += 0.02
    assert breaker._should_attempt_reset() is True


def test_circuit_breaker_transition_to_sets_internal_state(breaker, monkeypatch):
    """Test _transition_to adjusts internal counters and timestamps."""
    # Test transition to OPEN sets _opened_at
    with patch("src.circuit_breaker.time.time", return_value=123.456):
        breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(123.456)

    # Seed sliding window
    breaker._sliding_window.extend([True, False, True])
    breaker._failure_count = 5
    breaker._success_count = 4

    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0

    # Transition to HALF_OPEN resets probes and success count
    breaker._success_count = 7
    breaker._half_open_calls = 9
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0


def test_circuit_breaker_allow_request_in_various_states(basic_config):
    """Test _allow_request behavior in CLOSED, OPEN, and HALF_OPEN states."""
    cb = CircuitBreaker.get_or_create("svc-allow", basic_config)

    # CLOSED allows
    assert cb._allow_request() is True

    # OPEN denies
    cb._transition_to(CircuitState.OPEN)
    assert cb._allow_request() is False

    # HALF_OPEN allows up to half_open_max_calls then denies
    cb._transition_to(CircuitState.HALF_OPEN)
    allowed = [cb._allow_request() for _ in range(basic_config.half_open_max_calls)]
    assert all(allowed) is True
    assert cb._allow_request() is False


def test_circuit_breaker_execute_success_records_metrics(breaker):
    """Test execute on success updates metrics and sliding window."""
    # time sequence: start, end, last_success_time
    with patch("src.circuit_breaker.time.time", side_effect=[100.0, 100.1, 100.2]):
        result = breaker.execute(lambda: 42)
    assert result == 42
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.average_response_time == pytest.approx(0.1)
    assert list(breaker._sliding_window) == [True]


def test_circuit_breaker_execute_failure_records_and_raises(breaker):
    """Test execute on failure increments failed metrics and re-raises the exception."""
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 10.05, 10.06]):
        with pytest.raises(ValueError):
            breaker.execute(lambda: (_ for _ in ()).throw(ValueError("boom")))
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1
    assert breaker._failure_count == 1
    assert breaker.state == CircuitState.CLOSED
    assert list(breaker._sliding_window) == [False]


def test_circuit_breaker_record_failure_opens_when_threshold_reached(breaker):
    """Test that repeated failures reach failure_threshold and open the breaker."""
    # First failure
    with patch("src.circuit_breaker.time.time", side_effect=[1.0, 1.02, 1.03]):
        with pytest.raises(RuntimeError):
            # Use a generic runtime error
            breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail1")))
    # Second failure triggers OPEN (since failure_threshold=2)
    with patch("src.circuit_breaker.time.time", side_effect=[2.0, 2.03, 2.04, 2.05]):
        with pytest.raises(RuntimeError):
            breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail2")))
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(2.05)


def test_circuit_breaker_opens_on_failure_rate_exceeded(monkeypatch):
    """Test opening based on failure rate once sliding window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # avoid opening due to count
        success_threshold=2,
        timeout_seconds=1.0,
        half_open_max_calls=3,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    cb = CircuitBreaker.get_or_create("svc-rate", cfg)

    # success
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 10.01, 10.02]):
        cb.execute(lambda: "ok")
    # failure
    with patch("src.circuit_breaker.time.time", side_effect=[11.0, 11.01, 11.02]):
        with pytest.raises(Exception):
            cb.execute(lambda: (_ for _ in ()).throw(Exception("x")))
    # success
    with patch("src.circuit_breaker.time.time", side_effect=[12.0, 12.01, 12.02]):
        cb.execute(lambda: "ok")
    # failure - at this point window will be full (True, False, True, False) => 0.5 => open
    with patch("src.circuit_breaker.time.time", side_effect=[13.0, 13.01, 13.02, 13.03]):
        with pytest.raises(Exception):
            cb.execute(lambda: (_ for _ in ()).throw(Exception("y")))
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_behaviors():
    """Test _calculate_failure_rate returns 0 until window is full, then correct ratio."""
    cfg = CircuitBreakerConfig(sliding_window_size=3)
    cb = CircuitBreaker.get_or_create("svc-rate-calc", cfg)
    cb._sliding_window.extend([True, False])
    assert cb._calculate_failure_rate() == pytest.approx(0.0)
    cb._sliding_window.clear()
    cb._sliding_window.extend([True, False, False])
    assert cb._calculate_failure_rate() == pytest.approx(2 / 3)


def test_circuit_breaker_get_health_info_structure(breaker):
    """Test health info contains expected fields and calculations."""
    # One success with known timing
    with patch("src.circuit_breaker.time.time", side_effect=[100.0, 100.2, 100.3]):
        breaker.execute(lambda: "ok")
    info = breaker.get_health_info()
    assert info["name"] == "test-service"
    assert info["state"] == CircuitState.CLOSED.value
    assert "metrics" in info
    assert "config" in info
    assert "failure_rate" in info
    # failure rate 0 when window not full
    assert info["failure_rate"] == pytest.approx(0.0)
    assert info["metrics"]["total_calls"] == 1
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 0
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(
        breaker.metrics.average_response_time * 1000
    )


def test_circuit_breaker_half_open_success_transitions_to_closed(monkeypatch):
    """Test that in HALF_OPEN state, reaching success_threshold transitions to CLOSED."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2, success_threshold=2, timeout_seconds=1.0, half_open_max_calls=3
    )
    cb = CircuitBreaker.get_or_create("svc-half-open", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)
    # perform two successful executions
    with patch("src.circuit_breaker.time.time", side_effect=[1.0, 1.02, 1.03]):
        cb.execute(lambda: "ok-1")
    with patch("src.circuit_breaker.time.time", side_effect=[2.0, 2.02, 2.03]):
        cb.execute(lambda: "ok-2")
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_half_open_failure_transitions_to_open():
    """Test that a failure in HALF_OPEN transitions immediately back to OPEN."""
    cfg = CircuitBreakerConfig(
        failure_threshold=5, success_threshold=2, timeout_seconds=1.0, half_open_max_calls=2
    )
    cb = CircuitBreaker.get_or_create("svc-half-open-fail", cfg)
    cb._transition_to(CircuitState.HALF_OPEN)
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 10.01, 10.02, 10.03]):
        with pytest.raises(RuntimeError):
            cb.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_execute_respects_fallback_when_open(breaker, monkeypatch):
    """Test that execute uses fallback and counts rejected_calls when breaker is OPEN."""
    current = [200.0]

    def fake_time():
        return current[0]

    monkeypatch.setattr("src.circuit_breaker.time.time", fake_time)
    breaker._transition_to(CircuitState.OPEN)
    # Keep time within timeout to avoid resetting to HALF_OPEN
    current[0] += breaker.config.timeout_seconds - 0.1

    result = breaker.execute(lambda: "won't run", fallback=lambda: "fallback")
    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1


def test_circuit_breaker_decorator_wraps_function_and_uses_breaker():
    """Test circuit_breaker decorator wraps function and attaches breaker."""
    cfg = CircuitBreakerConfig()
    decorated_calls = {"count": 0}

    @circuit_breaker("decorated-svc", cfg)
    def sample(x, y):
        decorated_calls["count"] += 1
        return x + y

    # Ensure attributes
    assert hasattr(sample, "__wrapped__")
    assert hasattr(sample, "circuit_breaker")
    assert isinstance(sample.circuit_breaker, CircuitBreaker)

    result = sample(2, 3)
    assert result == 5
    assert decorated_calls["count"] == 1
    assert sample.circuit_breaker.metrics.total_calls == 1

    # Force breaker to OPEN and ensure wrapper raises open error (no fallback)
    sample.circuit_breaker._transition_to(CircuitState.OPEN)
    with patch("src.circuit_breaker.time.time", return_value=time.time()):
        with pytest.raises(CircuitBreakerOpenError):
            sample(1, 1)


def test_distributed_coordinator_register_breaker_sends_registration(coordinator, breaker):
    """Test register_breaker sends registration request and stores breaker."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        coordinator.register_breaker(breaker)
        assert "test-service" in coordinator._breakers
        mock_urlopen.assert_called_once()
        # Inspect request
        req_arg = mock_urlopen.call_args[0][0]
        assert req_arg.full_url.endswith("/circuit-breakers/register")
        assert req_arg.method == "POST"
        payload = json.loads(req_arg.data.decode("utf-8"))
        assert payload["service"] == "test-service"
        assert "failure_threshold" in payload


def test_distributed_coordinator_register_breaker_handles_urlerror(coordinator, breaker):
    """Test register_breaker swallows URLError and still registers locally."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("fail")):
        coordinator.register_breaker(breaker)
        assert "test-service" in coordinator._breakers


def test_distributed_coordinator_start_and_stop_sync_invokes_synchronize(coordinator):
    """Test start_sync starts a thread that calls _synchronize_states repeatedly."""
    calls = []

    def fake_sync():
        calls.append(1)

    with patch.object(coordinator, "_synchronize_states", side_effect=fake_sync):
        coordinator.start_sync()
        time.sleep(0.05)
        coordinator.stop_sync()
    assert len(calls) > 0


def test_distributed_coordinator_synchronize_states_posts_for_each_breaker(coordinator):
    """Test _synchronize_states posts state for every registered breaker and includes health info."""
    cfg = CircuitBreakerConfig()
    br1 = CircuitBreaker.get_or_create("svc1", cfg)
    br2 = CircuitBreaker.get_or_create("svc2", cfg)
    coordinator.register_breaker(br1)
    coordinator.register_breaker(br2)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        coordinator._synchronize_states()
        assert mock_urlopen.call_count == 2
        # Validate one of the requests payload
        for call in mock_urlopen.call_args_list:
            req = call[0][0]
            assert req.full_url.endswith("/circuit-breakers/state")
            assert req.method == "POST"
            data = json.loads(req.data.decode("utf-8"))
            assert "service" in data
            assert data["state"] in [CircuitState.CLOSED.value, CircuitState.OPEN.value, CircuitState.HALF_OPEN.value]
            assert "health_info" in data
            assert data["health_info"]["name"] == data["service"]


def test_distributed_coordinator_synchronize_states_handles_urlerror(coordinator, breaker):
    """Test _synchronize_states swallows URLError exceptions."""
    coordinator.register_breaker(breaker)
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        # Should not raise
        coordinator._synchronize_states()


def test_distributed_coordinator_get_cluster_state_success(coordinator):
    """Test get_cluster_state fetches and parses JSON from coordinator."""
    response_data = {"ok": True, "services": []}
    mock_response = Mock()
    mock_response.read.return_value = json.dumps(response_data).encode("utf-8")
    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=mock_response):
        result = coordinator.get_cluster_state("svc")
    assert result == response_data


def test_distributed_coordinator_get_cluster_state_error(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("fail")):
        result = coordinator.get_cluster_state("svc")
    assert result == {"error": "Failed to fetch cluster state"}