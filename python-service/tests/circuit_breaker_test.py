import json
import threading
import time
from unittest.mock import Mock, patch

import pytest
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
    """Reset the CircuitBreaker registry and ensure clean environment per test."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {}, raising=False)


@pytest.fixture
def small_config():
    """Provide a small config for fast state transitions."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.1,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.75,
    )


@pytest.fixture
def breaker(small_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=small_config)


def test_CircuitBreakerMetrics_record_response_time_updates_average():
    """record_response_time should append and update the moving average."""
    m = CircuitBreakerMetrics()
    m.record_response_time(0.1)
    m.record_response_time(0.3)
    assert m.average_response_time == pytest.approx(0.2)
    assert len(m._response_times) == 2


def test_CircuitBreaker_get_or_create_returns_singleton_per_name(small_config):
    """get_or_create should return same instance for the same name."""
    name = "singleton"
    a = CircuitBreaker.get_or_create(name, small_config)
    b = CircuitBreaker.get_or_create(name, small_config)
    c = CircuitBreaker.get_or_create("other", small_config)
    assert a is b
    assert a is not c
    assert a.name == name
    assert b.name == name
    assert c.name == "other"


def test_CircuitBreaker_initial_state_closed_and_metrics(breaker):
    """CircuitBreaker initializes to CLOSED with zeroed counters."""
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.total_calls == 0
    assert breaker.metrics.successful_calls == 0
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.rejected_calls == 0
    assert len(breaker._sliding_window) == 0
    assert breaker._sliding_window.maxlen == breaker.config.sliding_window_size


def test_CircuitBreaker_transition_to_updates_fields(breaker):
    """_transition_to should set/clear values per state and increment transitions count."""
    start_transitions = breaker.metrics.state_transitions

    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at is not None
    assert breaker.metrics.state_transitions == start_transitions + 1

    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0
    assert breaker.metrics.state_transitions == start_transitions + 2

    # Add to sliding window then close to ensure it is cleared
    breaker._sliding_window.append(True)
    assert len(breaker._sliding_window) == 1
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0
    assert breaker.metrics.state_transitions == start_transitions + 3


def test_CircuitBreaker_execute_success_records_metrics_and_window(breaker):
    """Successful execute should update metrics and sliding window."""
    result = breaker.execute(lambda: "ok")
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.average_response_time > 0
    assert breaker.metrics.last_success_time is not None
    assert len(breaker._sliding_window) == 1
    assert breaker._sliding_window[-1] is True


def test_CircuitBreaker_execute_failure_increments_and_trips_at_threshold():
    """Failures should increment counters and open breaker at threshold."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=1.0,
        sliding_window_size=10,
        failure_rate_threshold=0.9,  # high to avoid rate trip
    )
    br = CircuitBreaker(name="fail-threshold", config=cfg)

    def op_fail():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        br.execute(op_fail)
    assert br.metrics.failed_calls == 1
    assert br.state == CircuitState.CLOSED

    with pytest.raises(ValueError):
        br.execute(op_fail)

    assert br.metrics.failed_calls == 2
    assert br.state == CircuitState.OPEN
    assert br.metrics.state_transitions >= 1  # at least one to OPEN


def test_CircuitBreaker_calculate_failure_rate_only_when_window_full():
    """_calculate_failure_rate should be 0.0 until window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # avoid open due to count
        success_threshold=2,
        timeout_seconds=1.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=1.0,  # avoid open due to rate
    )
    br = CircuitBreaker("rate-window", cfg)

    # Append two failures; window not full yet
    br._record_failure(0.01)
    br._record_failure(0.01)
    assert br._calculate_failure_rate() == pytest.approx(0.0)

    # Now fill to maxlen with two successes
    br._record_success(0.01)
    br._record_success(0.01)
    assert len(br._sliding_window) == 4
    # Failure rate = 2 failures out of 4
    assert br._calculate_failure_rate() == pytest.approx(0.5)


def test_CircuitBreaker_failure_rate_threshold_trips_when_window_full():
    """Breaker should open when failure rate threshold is reached once window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,  # avoid trip by count
        success_threshold=2,
        timeout_seconds=1.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("rate-trip", cfg)

    # Fill window: success, success, fail, then fail -> at last failure, window is full and rate=0.5
    br.execute(lambda: "ok")
    br.execute(lambda: "ok")

    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("x")))

    # On this failure, window len is 3; rate not computed yet
    assert br.state == CircuitState.CLOSED

    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("y")))

    # Now window is full and rate = 0.5 >= threshold -> should be OPEN
    assert br.state == CircuitState.OPEN


def test_CircuitBreaker_allow_request_half_open_throttling():
    """In HALF_OPEN, only half_open_max_calls are allowed; excess are rejected."""
    cfg = CircuitBreakerConfig(
        failure_threshold=5,
        success_threshold=3,  # higher than half_open_max_calls to avoid closing
        timeout_seconds=0.01,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.9,
    )
    br = CircuitBreaker("half-open-throttle", cfg)

    # Trip to OPEN
    br._transition_to(CircuitState.OPEN)
    # Make timeout elapsed so state checks move to HALF_OPEN
    br._opened_at = time.time() - cfg.timeout_seconds - 0.001

    # First two calls allowed in HALF_OPEN
    assert br.execute(lambda: "ok") == "ok"
    assert br.execute(lambda: "ok") == "ok"
    assert br._success_count == 2
    assert br.state == CircuitState.HALF_OPEN

    # Third call should be rejected
    with pytest.raises(CircuitBreakerOpenError) as exc:
        br.execute(lambda: "ok")
    assert br.metrics.rejected_calls == 1
    assert exc.value.remaining_time == pytest.approx(0.0)


def test_CircuitBreaker_half_open_success_threshold_closes():
    """In HALF_OPEN, reaching success_threshold should close the breaker."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.01,
        half_open_max_calls=5,
        sliding_window_size=4,
        failure_rate_threshold=0.9,
    )
    br = CircuitBreaker("half-open-success", cfg)
    br._transition_to(CircuitState.OPEN)
    br._opened_at = time.time() - cfg.timeout_seconds - 0.001

    # Two successful calls in HALF_OPEN closes breaker
    assert br.execute(lambda: "ok") == "ok"
    assert br.execute(lambda: "ok") == "ok"
    assert br.state == CircuitState.CLOSED


def test_CircuitBreaker_half_open_failure_trips_open():
    """Any failure in HALF_OPEN should trip breaker back to OPEN."""
    cfg = CircuitBreakerConfig(
        failure_threshold=5,
        success_threshold=10,
        timeout_seconds=0.01,
        half_open_max_calls=5,
        sliding_window_size=4,
        failure_rate_threshold=0.9,
    )
    br = CircuitBreaker("half-open-failure", cfg)
    br._transition_to(CircuitState.OPEN)
    br._opened_at = time.time() - cfg.timeout_seconds - 0.001

    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("fail")))
    assert br.state == CircuitState.OPEN


def test_CircuitBreaker_execute_rejected_with_fallback_returns_value():
    """When breaker is OPEN, execute should return fallback value and count rejection."""
    cfg = CircuitBreakerConfig(timeout_seconds=5.0)
    br = CircuitBreaker("fallback-open", cfg)
    br._transition_to(CircuitState.OPEN)
    br._opened_at = time.time()  # not enough time elapsed

    fb = Mock(return_value="fallback")
    result = br.execute(lambda: "won't run", fallback=fb)
    assert result == "fallback"
    fb.assert_called_once_with()
    assert br.metrics.rejected_calls == 1
    assert br.state == CircuitState.OPEN


def test_CircuitBreakerOpenError_contents():
    """CircuitBreakerOpenError should contain name and remaining_time in message."""
    e = CircuitBreakerOpenError("svc", 10.0)
    assert e.name == "svc"
    assert e.remaining_time == pytest.approx(10.0)
    msg = str(e)
    assert "Circuit breaker 'svc' is open." in msg
    assert "Retry after" in msg


def test_CircuitBreaker_record_success_reduces_failure_count():
    """In CLOSED, a success should decrease failure_count but not below zero."""
    cfg = CircuitBreakerConfig()
    br = CircuitBreaker("reduce-failure", cfg)
    br._failure_count = 2
    br.execute(lambda: "ok")
    assert br._failure_count == 1
    br.execute(lambda: "ok")
    assert br._failure_count == 0
    br.execute(lambda: "ok")
    assert br._failure_count == 0  # not below zero


def test_CircuitBreaker_get_health_info_structure_and_values(breaker):
    """get_health_info should return a comprehensive health dictionary with metrics."""
    breaker.execute(lambda: "ok")
    info = breaker.get_health_info()
    assert info["name"] == breaker.name
    assert info["state"] in (CircuitState.CLOSED.value, CircuitState.OPEN.value, CircuitState.HALF_OPEN.value)
    assert "failure_count" in info
    assert "success_count" in info
    assert "failure_rate" in info
    assert "metrics" in info
    assert "config" in info
    assert info["metrics"]["total_calls"] == 1
    assert info["metrics"]["successful_calls"] == 1
    # average_response_time_ms should reflect internal average_response_time * 1000
    expected_ms = breaker.metrics.average_response_time * 1000
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(expected_ms)


def test_DistributedCoordinator_register_breaker_sends_registration(monkeypatch, breaker):
    """register_breaker should store the breaker and send registration via HTTP POST."""
    monkeypatch.setenv("NODE_ID", "node-x")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)

    calls = []

    def fake_urlopen(req, timeout=5):
        calls.append(req)
        class DummyResp:
            def read(self): return b""
        return DummyResp()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen) as mocked:
        coord.register_breaker(breaker)
        assert breaker.name in coord._breakers
        mocked.assert_called()
        assert len(calls) == 1
        req = calls[0]
        # Validate URL and method
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"
        # Validate payload
        payload = json.loads(req.data.decode("utf-8"))
        assert payload["service"] == breaker.name
        assert payload["node_id"] == coord.node_id
        assert payload["failure_threshold"] == breaker.config.failure_threshold
        assert payload["success_threshold"] == breaker.config.success_threshold


def test_DistributedCoordinator_synchronize_states_posts_state(monkeypatch, breaker):
    """_synchronize_states should POST breaker state to coordinator."""
    monkeypatch.setenv("NODE_ID", "node-y")
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    coord.register_breaker(breaker)

    posted = []

    def fake_urlopen(req, timeout=5):
        posted.append((req.full_url, req.get_method(), json.loads(req.data.decode("utf-8"))))
        class Dummy:
            def read(self): return b""
        return Dummy()

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen):
        coord._synchronize_states()
        assert len(posted) == 1
        url, method, data = posted[0]
        assert url.endswith("/circuit-breakers/state")
        assert method == "POST"
        assert data["service"] == breaker.name
        assert data["node_id"] == coord.node_id
        assert "state" in data
        assert "failure_count" in data
        assert "timestamp" in data
        assert "health_info" in data
        assert data["health_info"]["name"] == breaker.name


def test_DistributedCoordinator_get_cluster_state_success(monkeypatch):
    """get_cluster_state should return parsed JSON on success."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    expected = {"ok": True}

    class Resp:
        def read(self):
            return json.dumps(expected).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=Resp()) as mocked:
        result = coord.get_cluster_state("svc")
        assert result == expected
        assert mocked.called


def test_DistributedCoordinator_get_cluster_state_error():
    """get_cluster_state should return error dict on URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("boom")):
        result = coord.get_cluster_state("svc")
        assert "error" in result


def test_DistributedCoordinator_start_and_stop_sync_calls_synchronize_states(monkeypatch):
    """start_sync should run a background thread that invokes _synchronize_states."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)

    called_evt = threading.Event()

    def side_effect():
        called_evt.set()
        # Stop loop after first call
        coord._running = False

    with patch.object(coord, "_synchronize_states", side_effect=side_effect) as mocked_sync:
        coord.start_sync()
        # Wait for thread to invoke synchronize at least once
        assert called_evt.wait(timeout=1.0)
        coord.stop_sync()
        assert mocked_sync.called


def test_circuit_breaker_decorator_basic(monkeypatch):
    """Decorator should wrap function and execute via CircuitBreaker."""
    # Ensure clean registry
    monkeypatch.setenv("NODE_ID", "node-z")
    cfg = CircuitBreakerConfig(failure_threshold=2, success_threshold=1, timeout_seconds=1.0)
    name = "decorated-service"

    @circuit_breaker(name=name, config=cfg)
    def add(a, b):
        return a + b

    # Verify attributes
    assert getattr(add, "__wrapped__", None) is not None
    assert hasattr(add, "circuit_breaker")
    br = add.circuit_breaker
    assert isinstance(br, CircuitBreaker)
    assert br.name == name

    # Call decorated function
    res = add(2, 3)
    assert res == 5
    assert br.metrics.total_calls == 1
    assert br.metrics.successful_calls == 1