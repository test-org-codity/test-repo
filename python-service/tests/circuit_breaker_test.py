import json
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from src.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerMetrics,
    CircuitBreakerOpenError,
    CircuitState,
    DistributedCircuitBreakerCoordinator,
)


@pytest.fixture(autouse=True)
def reset_circuit_breaker_registry():
    """Reset CircuitBreaker global registry to avoid test cross-talk."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def breaker_config():
    """Create a deterministic CircuitBreakerConfig for tests."""
    return CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(breaker_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="svc", config=breaker_config)


@pytest.fixture
def metrics():
    """Create CircuitBreakerMetrics instance for testing."""
    return CircuitBreakerMetrics()


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator for testing."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator", sync_interval=0.01)


def test_circuit_state_enum_values():
    """Test CircuitState enum values are as defined in source."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Test CircuitBreakerConfig default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == 30.0
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == 0.5


def test_circuit_breaker_metrics_record_response_time_updates_average(metrics):
    """Test record_response_time tracks average response time."""
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_metrics_record_response_time_keeps_last_100():
    """Test record_response_time keeps at most 100 response times."""
    m = CircuitBreakerMetrics()
    for _ in range(150):
        m.record_response_time(1.0)
    assert len(m._response_times) == 100
    assert m.average_response_time == pytest.approx(1.0)


def test_circuit_breaker_open_error_attributes_and_message():
    """Test CircuitBreakerOpenError stores attributes and formats message."""
    err = CircuitBreakerOpenError("svc", 1.23456)
    assert err.name == "svc"
    assert err.remaining_time == 1.23456
    assert "Circuit breaker 'svc' is open. Retry after 1.23s" in str(err)


def test_circuit_breaker_init_initial_state_and_counters(breaker, breaker_config):
    """Test CircuitBreaker initializes state, counters, window, and metrics."""
    assert breaker.name == "svc"
    assert breaker.config is breaker_config
    assert breaker.state == CircuitState.CLOSED

    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._half_open_calls == 0
    assert breaker._opened_at is None

    assert breaker.metrics.total_calls == 0
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.rejected_calls == 0
    assert breaker.metrics.state_transitions == 0

    assert len(breaker._sliding_window) == 0
    assert breaker._sliding_window.maxlen == breaker_config.sliding_window_size


def test_circuit_breaker_get_or_create_returns_same_instance_and_keeps_first_config(breaker_config):
    """Test get_or_create caches by name and does not replace existing instance/config."""
    cfg1 = breaker_config
    cfg2 = CircuitBreakerConfig(failure_threshold=99)

    b1 = CircuitBreaker.get_or_create("svc", cfg1)
    b2 = CircuitBreaker.get_or_create("svc", cfg2)

    assert b1 is b2
    assert b2.config is cfg1
    assert CircuitBreaker._registry["svc"] is b1


def test_circuit_breaker_should_attempt_reset_false_when_never_opened(breaker):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_after_timeout(breaker):
    """Test _should_attempt_reset returns True after timeout has elapsed."""
    breaker._opened_at = 100.0
    breaker.config.timeout_seconds = 10.0
    with patch("src.circuit_breaker.time.time", return_value=110.0):
        assert breaker._should_attempt_reset() is True


def test_circuit_breaker_should_attempt_reset_false_before_timeout(breaker):
    """Test _should_attempt_reset returns False before timeout has elapsed."""
    breaker._opened_at = 100.0
    breaker.config.timeout_seconds = 10.0
    with patch("src.circuit_breaker.time.time", return_value=109.999):
        assert breaker._should_attempt_reset() is False


def test_circuit_breaker_state_auto_transitions_open_to_half_open_after_timeout(breaker):
    """Test state property transitions OPEN->HALF_OPEN when timeout has elapsed."""
    breaker._state = CircuitState.OPEN
    breaker._opened_at = 100.0
    breaker.config.timeout_seconds = 10.0

    with patch("src.circuit_breaker.time.time", return_value=111.0):
        assert breaker.state == CircuitState.HALF_OPEN
        assert breaker.metrics.state_transitions == 1
        assert breaker._half_open_calls == 0
        assert breaker._success_count == 0


def test_circuit_breaker_transition_to_open_sets_opened_at_and_increments_transitions(breaker):
    """Test _transition_to(OPEN) sets opened time and increments transitions."""
    with patch("src.circuit_breaker.time.time", return_value=123.45):
        breaker._transition_to(CircuitState.OPEN)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(123.45)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_half_open_resets_half_open_calls_and_success_count(breaker):
    """Test _transition_to(HALF_OPEN) resets half-open call counter and success_count."""
    breaker._half_open_calls = 99
    breaker._success_count = 10
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_transition_to_closed_resets_counters_and_clears_sliding_window(breaker):
    """Test _transition_to(CLOSED) resets counts, opened_at, and clears sliding window."""
    breaker._state = CircuitState.OPEN
    breaker._failure_count = 5
    breaker._success_count = 2
    breaker._opened_at = 123.0
    breaker._sliding_window.extend([True, False, False])

    breaker._transition_to(CircuitState.CLOSED)

    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_allow_request_closed_true(breaker):
    """Test _allow_request returns True in CLOSED state."""
    breaker._state = CircuitState.CLOSED
    assert breaker._allow_request() is True


def test_circuit_breaker_allow_request_open_false(breaker):
    """Test _allow_request returns False in OPEN state."""
    breaker._state = CircuitState.OPEN
    assert breaker._allow_request() is False


def test_circuit_breaker_allow_request_half_open_allows_up_to_max_calls(breaker):
    """Test _allow_request in HALF_OPEN allows limited number of calls and increments counter."""
    breaker._state = CircuitState.HALF_OPEN
    breaker.config.half_open_max_calls = 2

    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 1

    assert breaker._allow_request() is True
    assert breaker._half_open_calls == 2

    assert breaker._allow_request() is False
    assert breaker._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_decrements_failure_count(breaker):
    """Test execute() success updates metrics, response times, and reduces failure_count by 1 in CLOSED."""
    breaker._state = CircuitState.CLOSED
    breaker._failure_count = 2

    times = [100.0, 100.5, 100.5, 100.5]  # start, after op, last_success_time, record_response_time doesn't call time
    with patch("src.circuit_breaker.time.time", side_effect=times):
        result = breaker.execute(lambda: "ok")

    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.5)
    assert breaker._failure_count == 1
    assert list(breaker._sliding_window) == [True]


def test_circuit_breaker_execute_failure_records_metrics_and_raises(breaker):
    """Test execute() failure updates metrics and re-raises original exception."""
    breaker._state = CircuitState.CLOSED

    def op():
        raise ValueError("boom")

    times = [200.0, 200.25, 200.25]
    with patch("src.circuit_breaker.time.time", side_effect=times):
        with pytest.raises(ValueError, match="boom"):
            breaker.execute(op)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.average_response_time == pytest.approx(0.25)
    assert list(breaker._sliding_window) == [False]


def test_circuit_breaker_execute_open_rejects_and_raises_open_error_with_remaining_time(breaker):
    """Test execute() when OPEN rejects call, increments rejected_calls, and raises CircuitBreakerOpenError."""
    breaker._state = CircuitState.OPEN
    breaker.config.timeout_seconds = 10.0
    breaker._opened_at = 100.0

    with patch("src.circuit_breaker.time.time", return_value=104.0):
        with pytest.raises(CircuitBreakerOpenError) as ei:
            breaker.execute(lambda: "nope")

    assert breaker.metrics.rejected_calls == 1
    assert ei.value.name == "svc"
    assert ei.value.remaining_time == pytest.approx(6.0)


def test_circuit_breaker_execute_open_uses_fallback_and_increments_rejected_calls(breaker):
    """Test execute() when OPEN uses fallback if provided and does not raise."""
    breaker._state = CircuitState.OPEN
    breaker._opened_at = 100.0
    breaker.config.timeout_seconds = 10.0

    with patch("src.circuit_breaker.time.time", return_value=101.0):
        result = breaker.execute(lambda: "primary", fallback=lambda: "fallback")

    assert result == "fallback"
    assert breaker.metrics.rejected_calls == 1
    assert breaker.metrics.total_calls == 0  # total_calls increments only when request allowed


def test_circuit_breaker_record_failure_opens_when_failure_threshold_reached(breaker):
    """Test _record_failure transitions CLOSED->OPEN once failure_count >= failure_threshold."""
    breaker._state = CircuitState.CLOSED
    breaker.config.failure_threshold = 3
    breaker.config.sliding_window_size = breaker._sliding_window.maxlen
    breaker.config.failure_rate_threshold = 1.0  # avoid failure rate opening earlier

    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker._record_failure(0.1)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 1

    with patch("src.circuit_breaker.time.time", return_value=11.0):
        breaker._record_failure(0.1)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 2

    with patch("src.circuit_breaker.time.time", return_value=12.0):
        breaker._record_failure(0.1)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(12.0)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_record_failure_opens_when_failure_rate_threshold_reached(breaker):
    """Test _record_failure transitions CLOSED->OPEN when sliding window failure rate exceeds threshold."""
    breaker._state = CircuitState.CLOSED
    breaker.config.sliding_window_size = 4
    breaker._sliding_window = type(breaker._sliding_window)(maxlen=breaker.config.sliding_window_size)
    breaker.config.failure_threshold = 999  # ensure rate triggers first
    breaker.config.failure_rate_threshold = 0.5

    with patch("src.circuit_breaker.time.time", return_value=1.0):
        breaker._record_success(0.01)
    with patch("src.circuit_breaker.time.time", return_value=2.0):
        breaker._record_failure(0.01)
    with patch("src.circuit_breaker.time.time", return_value=3.0):
        breaker._record_failure(0.01)
    assert breaker._state == CircuitState.CLOSED  # still not enough window entries

    with patch("src.circuit_breaker.time.time", return_value=4.0):
        breaker._record_failure(0.01)

    assert list(breaker._sliding_window) == [True, False, False, False]
    assert breaker._calculate_failure_rate() == pytest.approx(0.75)
    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(4.0)


def test_circuit_breaker_calculate_failure_rate_returns_zero_until_window_full(breaker):
    """Test _calculate_failure_rate returns 0.0 until sliding window reaches configured size."""
    breaker.config.sliding_window_size = 4
    breaker._sliding_window = type(breaker._sliding_window)(maxlen=breaker.config.sliding_window_size)

    breaker._sliding_window.extend([False, True, False])
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    breaker._sliding_window.append(False)
    assert breaker._calculate_failure_rate() == pytest.approx(3 / 4)


def test_circuit_breaker_record_success_in_half_open_closes_after_success_threshold(breaker):
    """Test HALF_OPEN -> CLOSED after enough consecutive successes."""
    breaker._state = CircuitState.HALF_OPEN
    breaker.config.success_threshold = 2
    breaker._success_count = 0

    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker._record_success(0.1)
    assert breaker._state == CircuitState.HALF_OPEN
    assert breaker._success_count == 1

    with patch("src.circuit_breaker.time.time", return_value=11.0):
        breaker._record_success(0.1)
    assert breaker._state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_record_failure_in_half_open_transitions_to_open(breaker):
    """Test _record_failure in HALF_OPEN immediately transitions to OPEN."""
    breaker._state = CircuitState.HALF_OPEN
    breaker._opened_at = None

    with patch("src.circuit_breaker.time.time", return_value=99.0):
        breaker._record_failure(0.2)

    assert breaker._state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(99.0)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_get_health_info_includes_expected_fields_and_units(breaker):
    """Test get_health_info returns expected structure and average response time in ms."""
    breaker._state = CircuitState.CLOSED
    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker.execute(lambda: "ok")
    with patch("src.circuit_breaker.time.time", return_value=20.0):
        try:
            breaker.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))
        except RuntimeError:
            pass

    info = breaker.get_health_info()
    assert info["name"] == "svc"
    assert info["state"] == "CLOSED"
    assert "failure_rate" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 1
    assert info["metrics"]["rejected_calls"] == 0
    assert "average_response_time_ms" in info["metrics"]
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(breaker.metrics.average_response_time * 1000)
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker.config.success_threshold
    assert info["config"]["timeout_seconds"] == breaker.config.timeout_seconds


def test_distributed_coordinator_init_sets_node_id_from_env(monkeypatch):
    """Test coordinator node_id uses NODE_ID env var when present."""
    monkeypatch.setenv("NODE_ID", "node-xyz")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=1.0)
    assert coord.node_id == "node-xyz"
    assert coord.coordinator_url == "http://coordinator"
    assert coord.sync_interval == 1.0


def test_distributed_coordinator_register_breaker_sends_registration(coordinator, breaker):
    """Test register_breaker stores breaker and calls _send_registration."""
    coordinator._send_registration = Mock()
    coordinator.register_breaker(breaker)
    assert coordinator._breakers["svc"] is breaker
    coordinator._send_registration.assert_called_once_with(breaker)


def test_distributed_coordinator_send_registration_posts_json(coordinator, breaker):
    """Test _send_registration makes a POST request to the register endpoint with expected payload."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        coordinator._send_registration(breaker)

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/register"
    assert req.method == "POST"
    assert req.headers.get("Content-type") == "application/json"

    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == "svc"
    assert payload["node_id"] == coordinator.node_id
    assert payload["failure_threshold"] == breaker.config.failure_threshold
    assert payload["success_threshold"] == breaker.config.success_threshold


def test_distributed_coordinator_send_registration_swallows_urlerror(coordinator, breaker):
    """Test _send_registration ignores URLError exceptions."""
    import urllib.error

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._send_registration(breaker)


def test_distributed_coordinator_synchronize_states_posts_state_for_each_breaker(coordinator, breaker):
    """Test _synchronize_states posts breaker state payload and includes health_info."""
    coordinator.register_breaker(breaker)

    with (
        patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen,
        patch("src.circuit_breaker.time.time", return_value=123.0),
    ):
        coordinator._synchronize_states()

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/state"
    assert req.method == "POST"
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == "svc"
    assert payload["node_id"] == coordinator.node_id
    assert payload["state"] == breaker.state.value
    assert payload["failure_count"] == breaker._failure_count
    assert payload["timestamp"] == int(123.0 * 1000)
    assert payload["health_info"]["name"] == "svc"


def test_distributed_coordinator_synchronize_states_swallows_urlerror(coordinator, breaker):
    """Test _synchronize_states ignores URLError per breaker."""
    import urllib.error

    coordinator.register_breaker(breaker)
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._synchronize_states()


def test_distributed_coordinator_get_cluster_state_success_returns_json(coordinator):
    """Test get_cluster_state returns decoded JSON when request succeeds."""
    fake_response = SimpleNamespace(read=lambda: b'{"ok": true, "value": 1}')
    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
        data = coordinator.get_cluster_state("svc")

    assert data == {"ok": True, "value": 1}
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == "http://coordinator/circuit-breakers/svc/aggregate"
    assert req.method == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    import urllib.error

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        data = coordinator.get_cluster_state("svc")
    assert data == {"error": "Failed to fetch cluster state"}


def test_distributed_coordinator_start_sync_starts_thread(coordinator):
    """Test start_sync sets running and creates/starts a daemon thread."""
    with patch("src.circuit_breaker.threading.Thread") as mock_thread_cls:
        mock_thread = Mock()
        mock_thread_cls.return_value = mock_thread

        coordinator.start_sync()

    assert coordinator._running is True
    mock_thread_cls.assert_called_once()
    _, kwargs = mock_thread_cls.call_args
    assert kwargs["target"] == coordinator._sync_loop
    assert kwargs["daemon"] is True
    mock_thread.start.assert_called_once()


def test_distributed_coordinator_stop_sync_joins_thread_if_present(coordinator):
    """Test stop_sync stops running and joins sync thread."""
    coordinator._running = True
    coordinator._sync_thread = Mock()

    coordinator.stop_sync()

    assert coordinator._running is False
    coordinator._sync_thread.join.assert_called_once_with(timeout=2)


def test_distributed_coordinator_sync_loop_calls_synchronize_and_sleeps_until_stopped(coordinator):
    """Test _sync_loop calls _synchronize_states and sleeps; exits when _running becomes False."""
    calls = {"count": 0}

    def sync_side_effect():
        calls["count"] += 1
        coordinator._running = False

    coordinator._running = True
    coordinator._synchronize_states = Mock(side_effect=sync_side_effect)

    with patch("src.circuit_breaker.time.sleep") as mock_sleep:
        coordinator._sync_loop()

    assert calls["count"] == 1
    mock_sleep.assert_called_once_with(coordinator.sync_interval)


def test_distributed_coordinator_sync_loop_swallows_exceptions_and_continues(coordinator):
    """Test _sync_loop ignores exceptions from _synchronize_states."""
    calls = {"count": 0}

    def sync_side_effect():
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("boom")
        coordinator._running = False

    coordinator._running = True
    coordinator._synchronize_states = Mock(side_effect=sync_side_effect)

    with patch("src.circuit_breaker.time.sleep") as mock_sleep:
        coordinator._sync_loop()

    assert calls["count"] == 2
    assert mock_sleep.call_count == 2
    mock_sleep.assert_called_with(coordinator.sync_interval)