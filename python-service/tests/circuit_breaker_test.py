import time
import json
import threading
import uuid
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


@pytest.fixture
def fast_config():
    """Provide a fast circuit breaker config for tests with small thresholds."""
    return CircuitBreakerConfig(
        failure_threshold=1,
        success_threshold=2,
        timeout_seconds=0.05,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker_instance(fast_config):
    """Create a CircuitBreaker instance with a unique name and fast config."""
    name = f"test-breaker-{uuid.uuid4()}"
    return CircuitBreaker(name=name, config=fast_config)


@pytest.fixture
def clear_registry(monkeypatch):
    """Ensure CircuitBreaker class registry is cleared before tests that use it."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})
    yield
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


def test_circuit_state_values():
    """Ensure CircuitState enum has expected string values."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """Verify default configuration values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_metrics_record_response_time_updates_average():
    """record_response_time should update average_response_time correctly."""
    m = CircuitBreakerMetrics()
    durations = [0.1, 0.2, 0.3]
    for d in durations:
        m.record_response_time(d)
    assert m.average_response_time == pytest.approx(sum(durations) / len(durations))


def test_metrics_record_response_time_uses_rolling_window():
    """record_response_time should keep average over the last 100 elements."""
    m = CircuitBreakerMetrics()
    durations = [float(i) for i in range(105)]  # 0..104
    for d in durations:
        m.record_response_time(d)
    last_100 = durations[-100:]
    expected_avg = sum(last_100) / len(last_100)
    assert m.average_response_time == pytest.approx(expected_avg)


def test_circuit_breaker_open_error_attributes_and_message():
    """CircuitBreakerOpenError should set attributes and format message."""
    err = CircuitBreakerOpenError("svc", 3.14159)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(3.14159)
    assert "Circuit breaker 'svc' is open." in str(err)
    assert "Retry after" in str(err)


def test_circuit_breaker_initialization(breaker_instance, fast_config):
    """CircuitBreaker initialization sets default state and counters."""
    br = breaker_instance
    assert br.state == CircuitState.CLOSED
    assert br._failure_count == 0
    assert br._success_count == 0
    assert br.metrics.total_calls == 0
    assert br.metrics.failed_calls == 0
    assert br.metrics.successful_calls == 0
    assert br._sliding_window.maxlen == fast_config.sliding_window_size


def test_circuit_breaker_get_or_create_singleton_behavior(clear_registry):
    """get_or_create returns the same instance for the same name."""
    name = f"shared-{uuid.uuid4()}"
    cfg1 = CircuitBreakerConfig(timeout_seconds=0.1)
    cfg2 = CircuitBreakerConfig(timeout_seconds=1.0)

    a = CircuitBreaker.get_or_create(name, cfg1)
    b = CircuitBreaker.get_or_create(name, cfg2)

    assert a is b
    assert a.config.timeout_seconds == pytest.approx(0.1)


def test_circuit_breaker_state_auto_transition_to_half_open_after_timeout(breaker_instance):
    """Breaker in OPEN should transition to HALF_OPEN after timeout in state property."""
    br = breaker_instance
    br._transition_to(CircuitState.OPEN)
    # make it eligible to attempt reset
    br._opened_at = time.time() - br.config.timeout_seconds - 0.01
    initial_transitions = br.metrics.state_transitions

    st = br.state
    assert st == CircuitState.HALF_OPEN
    assert br.metrics.state_transitions == initial_transitions + 1
    assert br._half_open_calls == 0
    assert br._success_count == 0


def test_circuit_breaker_should_attempt_reset_various_cases(breaker_instance):
    """_should_attempt_reset returns expected values for different timings."""
    br = breaker_instance

    br._opened_at = None
    assert br._should_attempt_reset() is False

    br._opened_at = time.time()
    assert br._should_attempt_reset() is False

    br._opened_at = time.time() - br.config.timeout_seconds - 0.01
    assert br._should_attempt_reset() is True


def test_circuit_breaker_transition_to_states_side_effects(breaker_instance):
    """_transition_to should set internal fields consistently."""
    br = breaker_instance

    br._transition_to(CircuitState.OPEN)
    assert br.state == CircuitState.OPEN
    assert br._opened_at is not None

    br._half_open_calls = 5
    br._success_count = 7
    br._transition_to(CircuitState.HALF_OPEN)
    assert br.state == CircuitState.HALF_OPEN
    assert br._half_open_calls == 0
    assert br._success_count == 0

    br._failure_count = 3
    br._success_count = 2
    br._sliding_window.append(True)
    br._transition_to(CircuitState.CLOSED)
    assert br.state == CircuitState.CLOSED
    assert br._failure_count == 0
    assert br._success_count == 0
    assert br._opened_at is None
    assert len(br._sliding_window) == 0


def test_circuit_breaker_execute_success_records_metrics_and_window(breaker_instance):
    """execute should call operation, record success, and update metrics."""
    br = breaker_instance
    result = br.execute(lambda: 42)

    assert result == 42
    assert br.metrics.total_calls == 1
    assert br.metrics.successful_calls == 1
    assert br.metrics.last_success_time is not None
    assert len(br._sliding_window) == 1
    assert br._sliding_window[-1] is True
    assert br.metrics.average_response_time > 0.0


def test_circuit_breaker_execute_failure_opens_on_threshold():
    """On failure in CLOSED and failure_threshold=1, breaker should open."""
    cfg = CircuitBreakerConfig(failure_threshold=1, sliding_window_size=4, failure_rate_threshold=0.9)
    br = CircuitBreaker(name=f"fail-open-{uuid.uuid4()}", config=cfg)

    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("boom")))

    assert br.state == CircuitState.OPEN
    assert br.metrics.failed_calls == 1
    assert len(br._sliding_window) == 1
    assert br._sliding_window[-1] is False
    assert br._failure_count == 1
    assert br.metrics.last_failure_time is not None


def test_circuit_breaker_execute_open_rejects_with_fallback(breaker_instance):
    """When OPEN and not ready, execute should reject and call fallback."""
    br = breaker_instance
    br._transition_to(CircuitState.OPEN)
    br._opened_at = time.time()  # just opened, not ready to reset

    initial_total = br.metrics.total_calls
    initial_rejected = br.metrics.rejected_calls

    val = br.execute(lambda: 1 / 0, fallback=lambda: "fallback-value")

    assert val == "fallback-value"
    assert br.metrics.total_calls == initial_total  # not incremented when rejected
    assert br.metrics.rejected_calls == initial_rejected + 1


def test_circuit_breaker_execute_open_rejects_without_fallback_raises(breaker_instance):
    """When OPEN and not ready, execute without fallback should raise CircuitBreakerOpenError."""
    br = breaker_instance
    br._transition_to(CircuitState.OPEN)
    br._opened_at = time.time()

    with pytest.raises(CircuitBreakerOpenError) as ei:
        br.execute(lambda: 123)
    err = ei.value
    assert err.name == br.name
    assert err.remaining_time == pytest.approx(br.config.timeout_seconds, rel=0.5, abs=0.5)
    assert br.name in str(err)


def test_circuit_breaker_allow_request_half_open_limits():
    """In HALF_OPEN, _allow_request should enforce half_open_max_calls limit."""
    cfg = CircuitBreakerConfig(half_open_max_calls=2)
    br = CircuitBreaker(name=f"half-open-{uuid.uuid4()}", config=cfg)
    br._transition_to(CircuitState.HALF_OPEN)

    assert br._allow_request() is True
    assert br._allow_request() is True
    assert br._allow_request() is False


def test_circuit_breaker_half_open_success_threshold_transitions_to_closed():
    """In HALF_OPEN, reaching success_threshold should close the breaker."""
    cfg = CircuitBreakerConfig(success_threshold=2, half_open_max_calls=5)
    br = CircuitBreaker(name=f"half-open-success-{uuid.uuid4()}", config=cfg)
    br._transition_to(CircuitState.HALF_OPEN)

    res1 = br.execute(lambda: "ok1")
    res2 = br.execute(lambda: "ok2")

    assert res1 == "ok1"
    assert res2 == "ok2"
    assert br.state == CircuitState.CLOSED
    assert br._success_count == 0  # reset on closing


def test_circuit_breaker_half_open_failure_transitions_to_open():
    """In HALF_OPEN, any failure should re-open the breaker."""
    cfg = CircuitBreakerConfig()
    br = CircuitBreaker(name=f"half-open-fail-{uuid.uuid4()}", config=cfg)
    br._transition_to(CircuitState.HALF_OPEN)

    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("nope")))

    assert br.state == CircuitState.OPEN


def test_circuit_breaker_record_success_reduces_failure_count_not_below_zero():
    """_record_success should reduce failure_count but not below zero when CLOSED."""
    br = CircuitBreaker(name=f"success-reduce-{uuid.uuid4()}", config=CircuitBreakerConfig())
    br._failure_count = 2

    br._record_success(0.001)
    assert br._failure_count == 1

    br._record_success(0.001)
    br._record_success(0.001)
    assert br._failure_count == 0


def test_circuit_breaker_calculate_failure_rate_requires_full_window():
    """_calculate_failure_rate should be 0.0 until sliding window is full."""
    cfg = CircuitBreakerConfig(sliding_window_size=4, failure_threshold=100, failure_rate_threshold=0.5)
    br = CircuitBreaker(name=f"window-{uuid.uuid4()}", config=cfg)

    # fewer than window size
    br._record_failure(0.001)
    br._record_success(0.001)
    br._record_failure(0.001)
    assert br._calculate_failure_rate() == pytest.approx(0.0)

    # now fill to window size with a failure to reach 3/4 failures
    br._record_failure(0.001)
    assert br._calculate_failure_rate() == pytest.approx(0.75)


def test_circuit_breaker_failure_rate_opens_when_threshold_reached():
    """When sliding window full and failure rate >= threshold, breaker opens."""
    cfg = CircuitBreakerConfig(failure_threshold=100, sliding_window_size=4, failure_rate_threshold=0.5)
    br = CircuitBreaker(name=f"rate-open-{uuid.uuid4()}", config=cfg)

    # until window full, should not open
    br.execute(lambda: "ok")  # success
    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("f1")))
    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("f2")))
    # still len(window)=3 < 4, not open yet
    assert br.state == CircuitState.CLOSED

    # 4th failure fills window 3/4 failures => open
    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("f3")))
    assert br.state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_returns_expected_structure(breaker_instance):
    """get_health_info should return a snapshot with expected keys and values."""
    br = breaker_instance
    # produce a success and a failure
    br.execute(lambda: "ok")
    with pytest.raises(RuntimeError):
        br.execute(lambda: (_ for _ in ()).throw(RuntimeError("fail")))

    info = br.get_health_info()
    assert info["name"] == br.name
    assert info["state"] == br.state.value
    assert "failure_count" in info
    assert "success_count" in info
    assert "failure_rate" in info
    assert "metrics" in info
    metrics = info["metrics"]
    assert metrics["total_calls"] == br.metrics.total_calls
    assert metrics["successful_calls"] == br.metrics.successful_calls
    assert metrics["failed_calls"] == br.metrics.failed_calls
    assert metrics["rejected_calls"] == br.metrics.rejected_calls
    assert metrics["average_response_time_ms"] == pytest.approx(br.metrics.average_response_time * 1000)
    assert "state_transitions" in metrics
    assert "config" in info


def test_distributed_coordinator_register_breaker_sends_registration(breaker_instance):
    """register_breaker should POST to the coordinator registration endpoint."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example", sync_interval=0.01)
    captured = []

    def fake_urlopen(req, timeout=5):
        captured.append(req)
        resp = Mock()
        resp.read.return_value = b"{}"
        return resp

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen):
        coord.register_breaker(breaker_instance)

    assert len(captured) == 1
    req = captured[0]
    assert req.get_method() == "POST"
    assert req.full_url.endswith("/circuit-breakers/register")
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == breaker_instance.name
    assert payload["node_id"] == coord.node_id
    assert payload["failure_threshold"] == breaker_instance.config.failure_threshold
    assert payload["success_threshold"] == breaker_instance.config.success_threshold


def test_distributed_coordinator_start_and_stop_sync_posts_state_periodically(breaker_instance):
    """start_sync should spawn a thread that periodically posts breaker state."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example", sync_interval=0.01)
    coord.register_breaker(breaker_instance)
    requests = []
    lock = threading.Lock()

    def fake_urlopen(req, timeout=5):
        with lock:
            requests.append(req)
        resp = Mock()
        resp.read.return_value = b"{}"
        return resp

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=fake_urlopen):
        coord.start_sync()
        time.sleep(0.05)
        coord.stop_sync()

    # We expect at least one state sync POST in addition to initial registration POST
    assert any(r.full_url.endswith("/circuit-breakers/state") and r.get_method() == "POST" for r in requests)


def test_distributed_coordinator_synchronize_states_handles_urlerror(breaker_instance):
    """_synchronize_states should swallow URLError exceptions."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example", sync_interval=0.01)
    coord.register_breaker(breaker_instance)

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("network")), \
         patch.object(DistributedCircuitBreakerCoordinator, "_breakers", {breaker_instance.name: breaker_instance}):
        # Should not raise
        coord._synchronize_states()


def test_distributed_coordinator_get_cluster_state_success():
    """get_cluster_state should perform a GET and return parsed JSON."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example")
    resp = Mock()
    resp.read.return_value = json.dumps({"aggregate": {"OPEN": 1}}).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=resp) as mock_urlopen:
        data = coord.get_cluster_state("svc")
        assert data == {"aggregate": {"OPEN": 1}}
        assert mock_urlopen.call_count == 1


def test_distributed_coordinator_get_cluster_state_error():
    """get_cluster_state should return error dict on URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator.example")
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("down")):
        data = coord.get_cluster_state("svc")
        assert data == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_executes_function_and_attaches_breaker():
    """Decorator should return wrapper that uses a CircuitBreaker and exposes attributes."""
    cfg = CircuitBreakerConfig(failure_threshold=100)  # avoid unexpected OPEN
    name = f"decorator-{uuid.uuid4()}"

    @circuit_breaker(name=name, config=cfg)
    def sample(x, y):
        return x + y

    assert hasattr(sample, "circuit_breaker")
    assert sample.circuit_breaker.name == name

    result = sample(2, 3)
    assert result == 5
    assert sample.circuit_breaker.metrics.total_calls == 1