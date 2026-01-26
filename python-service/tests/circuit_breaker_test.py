import json
import threading
import urllib.error
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
    """Reset CircuitBreaker registry between tests to prevent cross-test state leakage."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Create a default CircuitBreakerConfig for testing."""
    return CircuitBreakerConfig()


@pytest.fixture
def breaker(default_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=default_config)


@pytest.fixture
def small_window_config():
    """Create a config with a small sliding window for failure-rate tests."""
    return CircuitBreakerConfig(
        failure_threshold=999,  # ensure failure-rate, not count, triggers OPEN
        success_threshold=2,
        timeout_seconds=10.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_small_window(small_window_config):
    """Create a CircuitBreaker with small sliding window for deterministic failure-rate behavior."""
    return CircuitBreaker(name="rate-breaker", config=small_window_config)


@pytest.fixture
def coordinator():
    """Create a DistributedCircuitBreakerCoordinator for testing."""
    return DistributedCircuitBreakerCoordinator(coordinator_url="http://coordinator.local", sync_interval=0.01)


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


def test_circuit_breaker_metrics_record_response_time_updates_average():
    """Test CircuitBreakerMetrics.record_response_time updates rolling average."""
    m = CircuitBreakerMetrics()
    m.record_response_time(1.0)
    assert m.average_response_time == pytest.approx(1.0)
    m.record_response_time(3.0)
    assert m.average_response_time == pytest.approx(2.0)


def test_circuit_breaker_metrics_record_response_time_respects_maxlen():
    """Test CircuitBreakerMetrics response time deque respects maxlen and average uses retained values."""
    m = CircuitBreakerMetrics()
    for i in range(150):
        m.record_response_time(float(i))
    assert len(m._response_times) == 100
    expected = sum(range(50, 150)) / 100.0
    assert m.average_response_time == pytest.approx(expected)


def test_circuit_breaker_open_error_contains_remaining_time_and_message():
    """Test CircuitBreakerOpenError sets name/remaining_time and formats message."""
    err = CircuitBreakerOpenError("svc", 1.2345)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.2345)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)


def test_circuit_breaker_init_defaults(default_config):
    """Test CircuitBreaker initialization sets expected defaults."""
    b = CircuitBreaker("init-breaker", default_config)
    assert b.name == "init-breaker"
    assert b.config is default_config
    assert b.state == CircuitState.CLOSED
    assert b._failure_count == 0
    assert b._success_count == 0
    assert b._half_open_calls == 0
    assert b._opened_at is None
    assert len(b._sliding_window) == 0
    assert b._sliding_window.maxlen == default_config.sliding_window_size
    assert b.metrics.total_calls == 0


def test_circuit_breaker_get_or_create_returns_same_instance_for_same_name():
    """Test CircuitBreaker.get_or_create returns same instance for same name."""
    b1 = CircuitBreaker.get_or_create("same")
    b2 = CircuitBreaker.get_or_create("same")
    assert b1 is b2


def test_circuit_breaker_get_or_create_ignores_new_config_if_existing():
    """Test get_or_create does not replace config for existing breaker."""
    cfg1 = CircuitBreakerConfig(failure_threshold=1)
    cfg2 = CircuitBreakerConfig(failure_threshold=999)
    b1 = CircuitBreaker.get_or_create("svc", cfg1)
    b2 = CircuitBreaker.get_or_create("svc", cfg2)
    assert b1 is b2
    assert b2.config.failure_threshold == 1


def test_circuit_breaker_should_attempt_reset_false_when_no_opened_at(breaker):
    """Test _should_attempt_reset returns False when _opened_at is None."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_should_attempt_reset_true_after_timeout(breaker):
    """Test _should_attempt_reset returns True when timeout has elapsed since _opened_at."""
    breaker.config.timeout_seconds = 10.0
    breaker._opened_at = 50.0
    with patch("src.circuit_breaker.time.time", return_value=60.0):
        assert breaker._should_attempt_reset() is True


def test_circuit_breaker_state_transitions_open_sets_opened_at_and_increments_metrics(breaker):
    """Test _transition_to(OPEN) sets opened timestamp and increments state_transitions."""
    with patch("src.circuit_breaker.time.time", return_value=123.0):
        breaker._transition_to(CircuitState.OPEN)
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(123.0)
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_state_transitions_half_open_resets_half_open_calls_and_success_count(breaker):
    """Test _transition_to(HALF_OPEN) resets half-open counters and increments metrics."""
    breaker._half_open_calls = 2
    breaker._success_count = 9
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_state_transitions_closed_resets_counts_and_clears_window(breaker):
    """Test _transition_to(CLOSED) resets counts, opened_at, and clears sliding window."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._opened_at = 99.0
    breaker._sliding_window.extend([True, False, False])
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert list(breaker._sliding_window) == []
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_state_property_auto_transitions_open_to_half_open_after_timeout(breaker):
    """Test state property triggers OPEN->HALF_OPEN after timeout expires."""
    breaker.config.timeout_seconds = 10.0
    with patch("src.circuit_breaker.time.time", return_value=100.0):
        breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(100.0)
    with patch("src.circuit_breaker.time.time", return_value=109.0):
        assert breaker.state == CircuitState.OPEN
    with patch("src.circuit_breaker.time.time", return_value=110.0):
        assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions == 2


def test_circuit_breaker_allow_request_closed_allows(breaker):
    """Test _allow_request returns True in CLOSED state."""
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._allow_request() is True


def test_circuit_breaker_allow_request_open_rejects(breaker):
    """Test _allow_request returns False in OPEN state."""
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._allow_request() is False


def test_circuit_breaker_allow_request_half_open_allows_up_to_max_calls_then_rejects(breaker):
    """Test HALF_OPEN allows up to half_open_max_calls and then rejects further attempts."""
    breaker.config.half_open_max_calls = 2
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._allow_request() is True
    assert breaker._allow_request() is True
    assert breaker._allow_request() is False
    assert breaker._half_open_calls == 2


def test_circuit_breaker_execute_success_records_metrics_and_returns_value(breaker):
    """Test execute on successful operation returns value and updates metrics."""
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 11.0, 11.0]):
        result = breaker.execute(lambda: "ok")
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(1.0)


def test_circuit_breaker_execute_failure_records_metrics_and_reraises(breaker):
    """Test execute on failing operation updates failure metrics and re-raises exception."""
    err = ValueError("boom")
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 10.5, 10.5]):
        with pytest.raises(ValueError) as excinfo:
            breaker.execute(lambda: (_ for _ in ()).throw(err))
    assert excinfo.value is err
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.average_response_time == pytest.approx(0.5)


def test_circuit_breaker_execute_open_rejected_raises_open_error_and_increments_rejected(breaker):
    """Test execute when OPEN rejects call, increments rejected_calls, and raises CircuitBreakerOpenError."""
    breaker.config.timeout_seconds = 30.0
    with patch("src.circuit_breaker.time.time", return_value=100.0):
        breaker._transition_to(CircuitState.OPEN)
    with patch("src.circuit_breaker.time.time", return_value=110.0):
        with pytest.raises(CircuitBreakerOpenError) as excinfo:
            breaker.execute(lambda: "nope")
    assert breaker.metrics.rejected_calls == 1
    assert excinfo.value.name == "test-breaker"
    assert excinfo.value.remaining_time == pytest.approx(20.0)


def test_circuit_breaker_execute_open_rejected_calls_fallback_and_increments_rejected(breaker):
    """Test execute when OPEN returns fallback result and increments rejected_calls."""
    with patch("src.circuit_breaker.time.time", return_value=50.0):
        breaker._transition_to(CircuitState.OPEN)
    with patch("src.circuit_breaker.time.time", return_value=55.0):
        result = breaker.execute(lambda: "op", fallback=lambda: "fb")
    assert result == "fb"
    assert breaker.metrics.rejected_calls == 1
    assert breaker.metrics.total_calls == 0  # rejected requests do not count as total_calls


def test_circuit_breaker_record_success_half_open_transitions_to_closed_on_success_threshold(breaker):
    """Test _record_success in HALF_OPEN increments success_count and closes when threshold met."""
    breaker.config.success_threshold = 2
    breaker._transition_to(CircuitState.HALF_OPEN)
    with patch("src.circuit_breaker.time.time", return_value=1.0):
        breaker._record_success(duration=0.1)
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker._success_count == 1
    with patch("src.circuit_breaker.time.time", return_value=2.0):
        breaker._record_success(duration=0.2)
    assert breaker.state == CircuitState.CLOSED
    assert breaker._success_count == 0
    assert breaker._failure_count == 0
    assert breaker._opened_at is None


def test_circuit_breaker_record_success_closed_decrements_failure_count_not_below_zero(breaker):
    """Test _record_success in CLOSED reduces failure_count by 1 but never below 0."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._failure_count = 0
    breaker._record_success(duration=0.01)
    assert breaker._failure_count == 0
    breaker._failure_count = 2
    breaker._record_success(duration=0.01)
    assert breaker._failure_count == 1


def test_circuit_breaker_record_failure_half_open_transitions_to_open(breaker):
    """Test _record_failure in HALF_OPEN transitions to OPEN."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    with patch("src.circuit_breaker.time.time", return_value=100.0):
        breaker._record_failure(duration=0.2)
    assert breaker.state == CircuitState.OPEN
    assert breaker._opened_at == pytest.approx(100.0)


def test_circuit_breaker_record_failure_closed_opens_on_failure_threshold(breaker):
    """Test _record_failure in CLOSED transitions to OPEN when failure_count reaches threshold."""
    breaker.config.failure_threshold = 2
    breaker.config.sliding_window_size = breaker.config.sliding_window_size  # no-op, clarity
    with patch("src.circuit_breaker.time.time", return_value=10.0):
        breaker._record_failure(duration=0.1)
    assert breaker.state == CircuitState.CLOSED
    with patch("src.circuit_breaker.time.time", return_value=11.0):
        breaker._record_failure(duration=0.1)
    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.state_transitions == 1


def test_circuit_breaker_calculate_failure_rate_returns_zero_until_window_full(breaker_small_window):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full."""
    b = breaker_small_window
    assert b._calculate_failure_rate() == pytest.approx(0.0)
    b._sliding_window.extend([False, False, True])  # length 3, window size 4
    assert b._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_computes_when_window_full(breaker_small_window):
    """Test _calculate_failure_rate computes failures/len once window is full."""
    b = breaker_small_window
    b._sliding_window.extend([False, True, False, True])  # 2 failures / 4
    assert b._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_record_failure_closed_opens_on_failure_rate_threshold(breaker_small_window):
    """Test _record_failure opens circuit when failure rate in full window meets/exceeds threshold."""
    b = breaker_small_window
    b._transition_to(CircuitState.CLOSED)

    # Fill window: 2 successes, then 2 failures -> failure rate becomes 0.5 (>= threshold 0.5)
    with patch("src.circuit_breaker.time.time", return_value=1.0):
        b._record_success(duration=0.01)
    with patch("src.circuit_breaker.time.time", return_value=2.0):
        b._record_success(duration=0.01)
    with patch("src.circuit_breaker.time.time", return_value=3.0):
        b._record_failure(duration=0.01)
    assert b.state == CircuitState.CLOSED  # window not full yet before next append? now len=3 so still 0 rate
    with patch("src.circuit_breaker.time.time", return_value=4.0):
        b._record_failure(duration=0.01)
    assert b.state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_contains_expected_fields_and_converts_average_to_ms(breaker):
    """Test get_health_info returns expected keys and average_response_time_ms is ms conversion."""
    breaker._transition_to(CircuitState.CLOSED)
    with patch("src.circuit_breaker.time.time", side_effect=[10.0, 10.2, 10.2]):
        breaker.execute(lambda: "ok")
    info = breaker.get_health_info()
    assert info["name"] == "test-breaker"
    assert info["state"] == "CLOSED"
    assert info["failure_count"] == 0
    assert info["success_count"] == 0
    assert info["failure_rate"] == pytest.approx(0.0)
    assert info["metrics"]["total_calls"] == 1
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 0
    assert info["metrics"]["rejected_calls"] == 0
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(200.0)
    assert info["config"]["failure_threshold"] == breaker.config.failure_threshold
    assert info["config"]["success_threshold"] == breaker.config.success_threshold
    assert info["config"]["timeout_seconds"] == pytest.approx(breaker.config.timeout_seconds)


def test_distributed_coordinator_init_sets_node_id_from_env(monkeypatch):
    """Test coordinator uses NODE_ID env var when present."""
    monkeypatch.setenv("NODE_ID", "node-xyz")
    c = DistributedCircuitBreakerCoordinator("http://x")
    assert c.node_id == "node-xyz"


def test_distributed_coordinator_register_breaker_stores_and_sends_registration(coordinator, breaker):
    """Test register_breaker stores breaker and calls _send_registration."""
    with patch.object(coordinator, "_send_registration") as mock_send:
        coordinator.register_breaker(breaker)
    assert coordinator._breakers["test-breaker"] is breaker
    mock_send.assert_called_once_with(breaker)


def test_distributed_coordinator_send_registration_posts_json_and_ignores_urlerror(coordinator, breaker):
    """Test _send_registration builds POST request and ignores URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")) as mock_urlopen:
        coordinator._send_registration(breaker)
    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/register"
    assert req.get_method() == "POST"
    assert req.headers.get("Content-type") == "application/json"
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == breaker.name
    assert payload["node_id"] == coordinator.node_id
    assert payload["failure_threshold"] == breaker.config.failure_threshold
    assert payload["success_threshold"] == breaker.config.success_threshold


def test_distributed_coordinator_start_sync_creates_daemon_thread(coordinator):
    """Test start_sync sets running and creates/starts daemon thread."""
    with patch("src.circuit_breaker.threading.Thread") as mock_thread_cls:
        mock_thread = Mock()
        mock_thread_cls.return_value = mock_thread

        coordinator.start_sync()

        assert coordinator._running is True
        mock_thread_cls.assert_called_once()
        kwargs = mock_thread_cls.call_args.kwargs
        assert kwargs["target"] == coordinator._sync_loop
        assert kwargs["daemon"] is True
        mock_thread.start.assert_called_once()


def test_distributed_coordinator_stop_sync_joins_thread(coordinator):
    """Test stop_sync sets running False and joins thread when present."""
    t = Mock(spec=threading.Thread)
    coordinator._sync_thread = t
    coordinator._running = True
    coordinator.stop_sync()
    assert coordinator._running is False
    t.join.assert_called_once()
    assert t.join.call_args.kwargs["timeout"] == pytest.approx(2)


def test_distributed_coordinator_sync_loop_calls_synchronize_and_sleeps_and_swallows_exceptions(coordinator):
    """Test _sync_loop calls _synchronize_states, swallows exceptions, and sleeps each loop."""
    coordinator._running = True

    def stop_after_first(*args, **kwargs):
        coordinator._running = False
        raise RuntimeError("boom")

    with (
        patch.object(coordinator, "_synchronize_states", side_effect=stop_after_first) as mock_sync,
        patch("src.circuit_breaker.time.sleep") as mock_sleep,
    ):
        coordinator._sync_loop()

    mock_sync.assert_called_once()
    mock_sleep.assert_called_once_with(coordinator.sync_interval)


def test_distributed_coordinator_synchronize_states_posts_state_for_each_registered_breaker(coordinator, breaker):
    """Test _synchronize_states POSTs JSON state for each registered breaker."""
    coordinator.register_breaker(breaker)

    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen, patch(
        "src.circuit_breaker.time.time", return_value=123.456
    ):
        coordinator._synchronize_states()

    assert mock_urlopen.call_count == 1
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/state"
    assert req.get_method() == "POST"
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == breaker.name
    assert payload["node_id"] == coordinator.node_id
    assert payload["state"] == breaker.state.value
    assert payload["failure_count"] == breaker._failure_count
    assert payload["timestamp"] == int(123.456 * 1000)
    assert payload["health_info"]["name"] == breaker.name


def test_distributed_coordinator_synchronize_states_ignores_urlerror(coordinator, breaker):
    """Test _synchronize_states ignores URLError from urlopen."""
    coordinator.register_breaker(breaker)
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        coordinator._synchronize_states()


def test_distributed_coordinator_get_cluster_state_success_returns_parsed_json(coordinator):
    """Test get_cluster_state returns decoded JSON on success."""
    response = Mock()
    response.read.return_value = b'{"ok": true, "value": 123}'

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=response) as mock_urlopen:
        data = coordinator.get_cluster_state("svc-a")

    assert data == {"ok": True, "value": 123}
    req = mock_urlopen.call_args.args[0]
    assert req.full_url == f"{coordinator.coordinator_url}/circuit-breakers/svc-a/aggregate"
    assert req.get_method() == "GET"


def test_distributed_coordinator_get_cluster_state_urlerror_returns_error_dict(coordinator):
    """Test get_cluster_state returns error dict on URLError."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
        data = coordinator.get_cluster_state("svc-a")
    assert data == {"error": "Failed to fetch cluster state"}