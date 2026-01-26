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
)


@pytest.fixture(autouse=True)
def clear_registry():
    """Ensure CircuitBreaker registry is clean before and after each test."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def config():
    """Return a CircuitBreakerConfig with small thresholds for tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.05,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker("test-service", config)


def success_op():
    return "ok"


def failing_op():
    raise ValueError("boom")


def test_circuit_state_values_sanity():
    """CircuitState enum should have expected values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_config_defaults_and_override():
    """CircuitBreakerConfig should initialize with defaults and respect overrides."""
    default_cfg = CircuitBreakerConfig()
    assert default_cfg.failure_threshold == 5
    assert default_cfg.success_threshold == 3
    assert default_cfg.timeout_seconds == pytest.approx(30.0)
    assert default_cfg.half_open_max_calls == 3
    assert default_cfg.sliding_window_size == 10
    assert default_cfg.failure_rate_threshold == pytest.approx(0.5)

    cfg = CircuitBreakerConfig(failure_threshold=10, timeout_seconds=1.2)
    assert cfg.failure_threshold == 10
    assert cfg.timeout_seconds == pytest.approx(1.2)


def test_metrics_record_response_time_average():
    """CircuitBreakerMetrics.record_response_time should compute average latency."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.2)
    assert metrics.average_response_time == pytest.approx(0.15)


def test_open_error_message_and_attributes():
    """CircuitBreakerOpenError should store name and remaining time and format message."""
    err = CircuitBreakerOpenError("svc", 1.2345)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.2345)
    assert "Circuit breaker 'svc' is open" in str(err)
    assert "Retry after" in str(err)


def test_get_or_create_registry_singleton_per_name(config):
    """CircuitBreaker.get_or_create should return same instance for same name."""
    br1 = CircuitBreaker.get_or_create("svcA", config)
    assert isinstance(br1, CircuitBreaker)
    br2 = CircuitBreaker.get_or_create("svcA", CircuitBreakerConfig(failure_threshold=99))
    assert br1 is br2
    # Existing config should not be replaced on subsequent get_or_create
    assert br2.config.failure_threshold == config.failure_threshold


def test_state_auto_transition_open_to_half_open_after_timeout(breaker):
    """Breaker.state should auto transition from OPEN to HALF_OPEN after timeout."""
    assert breaker.state == CircuitState.CLOSED
    breaker._transition_to(CircuitState.OPEN)
    assert breaker.state == CircuitState.OPEN
    transitions_before = breaker.metrics.state_transitions
    # Move opened_at in the past beyond timeout
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions == transitions_before + 1


def test_should_attempt_reset_logic(breaker):
    """_should_attempt_reset should reflect elapsed timeout since _opened_at."""
    assert breaker._should_attempt_reset() is False
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds - 0.01)
    assert breaker._should_attempt_reset() is False
    breaker._opened_at = time.time() - (breaker.config.timeout_seconds + 0.01)
    assert breaker._should_attempt_reset() is True


def test_transition_to_open_half_open_closed_resets(breaker):
    """_transition_to should manage internal counters and timestamps per state."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._sliding_window.extend([True, False])

    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at is not None

    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0

    breaker._failure_count = 5
    breaker._sliding_window.extend([True, False, True])

    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0


def test_execute_closed_success_updates_metrics_and_decrements_failure_count(breaker):
    """Successful execute should update metrics and reduce failure_count by 1 in CLOSED."""
    breaker._failure_count = 2
    result = breaker.execute(success_op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker._failure_count == 1  # decremented by 1 but not below 0

    # Another success decrements but not below zero
    breaker._failure_count = 0
    breaker.execute(success_op)
    assert breaker._failure_count == 0


def test_execute_closed_failure_increments_and_trips_on_threshold(config):
    """Failing execute raises and after reaching failure_threshold breaker opens."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=config.success_threshold,
        timeout_seconds=config.timeout_seconds,
        half_open_max_calls=config.half_open_max_calls,
        sliding_window_size=config.sliding_window_size,
        failure_rate_threshold=config.failure_rate_threshold,
    )
    br = CircuitBreaker("svc-fail", cfg)
    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.metrics.failed_calls == 1
    assert br._failure_count == 1
    assert br.state == CircuitState.CLOSED

    with pytest.raises(ValueError):
        br.execute(failing_op)

    assert br.metrics.failed_calls == 2
    assert br._failure_count == 2
    assert br.state == CircuitState.OPEN


def test_execute_open_rejects_and_fallback_called(breaker):
    """When OPEN, execute should reject and call fallback without incrementing total_calls."""
    breaker._transition_to(CircuitState.OPEN)
    rejected_before = breaker.metrics.rejected_calls
    total_before = breaker.metrics.total_calls
    res = breaker.execute(success_op, fallback=lambda: "fallback")
    assert res == "fallback"
    assert breaker.metrics.rejected_calls == rejected_before + 1
    assert breaker.metrics.total_calls == total_before


def test_execute_open_rejects_and_raises_with_remaining_time(breaker):
    """When OPEN and no fallback, execute should raise CircuitBreakerOpenError with remaining time."""
    breaker._transition_to(CircuitState.OPEN)
    breaker._opened_at = time.time()
    with pytest.raises(CircuitBreakerOpenError) as ei:
        breaker.execute(success_op)
    err = ei.value
    assert err.name == breaker.name
    assert err.remaining_time == pytest.approx(breaker.config.timeout_seconds, rel=0.1)


def test_allow_request_half_open_increments_and_blocks_after_max_calls(breaker):
    """_allow_request should allow up to half_open_max_calls in HALF_OPEN and then reject."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._allow_request() is True
    assert breaker._allow_request() is True
    assert breaker._allow_request() is False


def test_record_success_in_half_open_transitions_to_closed(breaker):
    """_record_success should transition HALF_OPEN to CLOSED after reaching success_threshold."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_success(0.01)
    assert breaker.state == CircuitState.HALF_OPEN
    breaker._record_success(0.01)
    assert breaker.state == CircuitState.CLOSED


def test_record_failure_in_half_open_transitions_to_open(breaker):
    """_record_failure should transition from HALF_OPEN to OPEN immediately."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker._record_failure(0.01)
    assert breaker.state == CircuitState.OPEN


def test_calculate_failure_rate_returns_zero_until_window_full_then_value(breaker):
    """_calculate_failure_rate should be 0 until window is full, then reflect failure ratio."""
    breaker._sliding_window.clear()
    breaker._sliding_window.extend([True, False])  # len=2 < size=4
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    breaker._sliding_window.extend([True, False])  # now len=4
    # two failures out of four -> 0.5
    assert breaker._calculate_failure_rate() == pytest.approx(0.5)


def test_failure_rate_trips_open_when_threshold_exceeded(config):
    """CLOSED breaker should trip OPEN when sliding window failure rate meets/exceeds threshold."""
    cfg = CircuitBreakerConfig(
        failure_threshold=10,  # ensure count threshold won't trigger first
        success_threshold=config.success_threshold,
        timeout_seconds=config.timeout_seconds,
        half_open_max_calls=config.half_open_max_calls,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("svc-rate", cfg)
    # Fill window: two successes
    br.execute(success_op)
    br.execute(success_op)
    # Two failures to reach exactly 0.5 failure rate on full window
    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.state == CircuitState.CLOSED  # not yet full window to evaluate
    with pytest.raises(ValueError):
        br.execute(failing_op)
    assert br.state == CircuitState.OPEN


def test_get_health_info_structure_and_values(breaker):
    """get_health_info should include state, metrics, config, and derived metrics."""
    breaker.metrics.record_response_time(0.1)
    info = breaker.get_health_info()
    assert info["name"] == breaker.name
    assert info["state"] == breaker.state.value
    assert info["failure_count"] == breaker._failure_count
    assert info["success_count"] == breaker._success_count
    assert info["failure_rate"] == pytest.approx(0.0)
    assert "metrics" in info
    assert info["metrics"]["total_calls"] == breaker.metrics.total_calls
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(100.0)
    assert "config" in info
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(breaker.config.timeout_seconds)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator with a dummy URL and small sync interval."""
    return DistributedCircuitBreakerCoordinator("http://coordinator.test", sync_interval=0.01)


def test_coordinator_register_breaker_calls_send_registration(coordinator, breaker):
    """register_breaker should store breaker and call _send_registration."""
    with patch.object(coordinator, "_send_registration") as mock_send:
        coordinator.register_breaker(breaker)
        assert "test-service" in coordinator._breakers
        mock_send.assert_called_once_with(breaker)


def test_coordinator_send_registration_posts_data_and_handles_error(coordinator, breaker):
    """_send_registration should POST JSON and swallow URLError exceptions."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_resp = Mock()
        mock_urlopen.return_value = mock_resp
        coordinator._send_registration(breaker)
        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert "/circuit-breakers/register" in req.full_url
        body = json.loads(req.data.decode("utf-8"))
        assert body["service"] == breaker.name
        assert body["failure_threshold"] == breaker.config.failure_threshold

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")):
        # Should not raise
        coordinator._send_registration(breaker)


def test_coordinator_start_and_stop_sync_calls_synchronize_states(coordinator):
    """start_sync should spawn a thread that periodically calls _synchronize_states, stop_sync should end it."""
    with patch.object(coordinator, "_synchronize_states") as mock_sync:
        coordinator.start_sync()
        time.sleep(0.03)
        coordinator.stop_sync()
        assert mock_sync.call_count >= 1


def test_coordinator_synchronize_states_posts_each_breaker_state(coordinator, config):
    """_synchronize_states should POST state for each registered breaker."""
    br1 = CircuitBreaker("svc1", config)
    br2 = CircuitBreaker("svc2", config)
    coordinator.register_breaker(br1)
    coordinator.register_breaker(br2)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coordinator._synchronize_states()
        # Two breakers => two posts
        assert mock_urlopen.call_count == 2
        urls = [call.args[0].full_url for call in mock_urlopen.call_args_list]
        assert all("/circuit-breakers/state" in u for u in urls)

        payloads = [json.loads(call.args[0].data.decode("utf-8")) for call in mock_urlopen.call_args_list]
        services = {p["service"] for p in payloads}
        assert services == {"svc1", "svc2"}
        for p in payloads:
            assert p["state"] in {CircuitState.CLOSED.value, CircuitState.OPEN.value, CircuitState.HALF_OPEN.value}
            assert "health_info" in p


def test_coordinator_get_cluster_state_success_and_error(coordinator):
    """get_cluster_state should return parsed JSON on success and error dict on URLError."""
    response_mock = Mock()
    response_mock.read.return_value = b'{"status": "ok", "count": 1}'
    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=response_mock):
        data = coordinator.get_cluster_state("svcX")
        assert data["status"] == "ok"
        assert data["count"] == 1

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")):
        data = coordinator.get_cluster_state("svcX")
        assert "error" in data


def test_execute_half_open_success_then_close(breaker):
    """In HALF_OPEN, enough successes should transition to CLOSED."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker.execute(success_op)
    assert breaker.state in (CircuitState.HALF_OPEN, CircuitState.CLOSED)
    # Success threshold is 2, second success closes it
    breaker.execute(success_op)
    assert breaker.state == CircuitState.CLOSED


def test_execute_half_open_failure_then_open(breaker):
    """In HALF_OPEN, a failure should transition back to OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    with pytest.raises(ValueError):
        breaker.execute(failing_op)
    assert breaker.state == CircuitState.OPEN


def test_rejected_calls_do_not_increment_total_calls(breaker):
    """Rejected requests (OPEN) should increment rejected_calls but not total_calls."""
    breaker._transition_to(CircuitState.OPEN)
    total_before = breaker.metrics.total_calls
    rejected_before = breaker.metrics.rejected_calls
    with pytest.raises(CircuitBreakerOpenError):
        breaker.execute(success_op)
    assert breaker.metrics.total_calls == total_before
    assert breaker.metrics.rejected_calls == rejected_before + 1