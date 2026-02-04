import json
import time
import threading
import pytest
from unittest.mock import Mock, patch
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
def fresh_registry():
    """Ensure CircuitBreaker registry is clean before each test."""
    CircuitBreaker._registry.clear()
    yield
    CircuitBreaker._registry.clear()


@pytest.fixture
def cb_config():
    """Provide a CircuitBreakerConfig with small thresholds for testing."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.5,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.75,
    )


@pytest.fixture
def cb_instance(cb_config):
    """Create a CircuitBreaker instance for tests."""
    return CircuitBreaker(name="test.service", config=cb_config)


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
    """Test that CircuitBreakerMetrics records response times and computes average."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3) / 2)


def test_circuit_breaker_open_error_message_and_attributes():
    """Test CircuitBreakerOpenError stores attributes and formats message."""
    err = CircuitBreakerOpenError("svc", 1.234)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(1.234)
    assert "Circuit breaker 'svc' is open. Retry after" in str(err)


def test_circuit_breaker_get_or_create_returns_singleton_by_name(cb_config):
    """Test get_or_create returns the same instance for the same name."""
    a = CircuitBreaker.get_or_create("singleton", cb_config)
    b = CircuitBreaker.get_or_create("singleton", cb_config)
    assert a is b
    assert a.name == "singleton"


def test_circuit_breaker_state_transitions_to_half_open_after_timeout(cb_instance, monkeypatch):
    """Test that state property transitions from OPEN to HALF_OPEN after timeout."""
    base = 1000.0
    monkeypatch.setattr(time, "time", lambda: base)
    cb_instance._transition_to(CircuitState.OPEN)
    transitions_before = cb_instance.metrics.state_transitions
    # Advance time past timeout
    monkeypatch.setattr(time, "time", lambda: base + cb_instance.config.timeout_seconds + 0.1)
    st = cb_instance.state
    assert st == CircuitState.HALF_OPEN
    assert cb_instance.metrics.state_transitions == transitions_before + 1


def test_circuit_breaker_should_attempt_reset_logic(cb_instance, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout."""
    base = 2000.0
    monkeypatch.setattr(time, "time", lambda: base)
    cb_instance._transition_to(CircuitState.OPEN)
    # Just before timeout
    monkeypatch.setattr(time, "time", lambda: base + cb_instance.config.timeout_seconds - 0.0001)
    assert cb_instance._should_attempt_reset() is False
    # After timeout
    monkeypatch.setattr(time, "time", lambda: base + cb_instance.config.timeout_seconds + 0.0001)
    assert cb_instance._should_attempt_reset() is True


def test_circuit_breaker_allow_request_half_open_limited_calls(cb_instance):
    """Test HALF_OPEN allows only limited number of calls."""
    cb_instance._transition_to(CircuitState.HALF_OPEN)
    allowed1 = cb_instance._allow_request()
    allowed2 = cb_instance._allow_request()
    allowed3 = cb_instance._allow_request()
    assert allowed1 is True
    assert allowed2 is True
    assert allowed3 is False
    assert cb_instance._half_open_calls == cb_instance.config.half_open_max_calls


def test_circuit_breaker_execute_success_records_metrics(cb_instance):
    """Test execute on success updates metrics and returns result."""
    result = cb_instance.execute(lambda: "ok")
    assert result == "ok"
    assert cb_instance.metrics.total_calls == 1
    assert cb_instance.metrics.successful_calls == 1
    assert cb_instance.metrics.average_response_time >= 0.0


def test_circuit_breaker_execute_failure_increments_and_trips_on_threshold(cb_config):
    """Test execute on failure increments metrics and opens after threshold."""
    # Lower threshold to 2 for quick open
    cb_config.failure_threshold = 2
    cb_config.failure_rate_threshold = 1.0  # Ensure rate doesn't open prematurely
    cb = CircuitBreaker("fail.test", cb_config)
    def boom():
        raise ValueError("fail")
    with pytest.raises(ValueError):
        cb.execute(boom)
    # First failure: still CLOSED
    assert cb.state == CircuitState.CLOSED
    assert cb.metrics.failed_calls == 1
    with pytest.raises(ValueError):
        cb.execute(boom)
    # After second failure: OPEN
    assert cb.state == CircuitState.OPEN
    assert cb.metrics.failed_calls == 2


def test_circuit_breaker_execute_open_raises_or_uses_fallback(cb_instance, monkeypatch):
    """Test execute rejects when OPEN: fallback is used or error raised with remaining time."""
    base = 3000.0
    monkeypatch.setattr(time, "time", lambda: base)
    cb_instance._transition_to(CircuitState.OPEN)

    # With fallback: should not raise, increments rejected_calls
    res = cb_instance.execute(lambda: "won't run", fallback=lambda: "fallback")
    assert res == "fallback"
    assert cb_instance.metrics.rejected_calls == 1

    # Without fallback: should raise CircuitBreakerOpenError
    with pytest.raises(CircuitBreakerOpenError) as exc:
        cb_instance.execute(lambda: "won't run")
    assert exc.value.name == cb_instance.name
    assert exc.value.remaining_time == pytest.approx(cb_instance.config.timeout_seconds)


def test_circuit_breaker_half_open_successes_lead_to_closed(cb_config, monkeypatch):
    """Test that in HALF_OPEN, after enough successes, breaker transitions to CLOSED."""
    cb_config.success_threshold = 2
    cb_config.half_open_max_calls = 3
    cb = CircuitBreaker("half.open.success", cb_config)
    cb._transition_to(CircuitState.HALF_OPEN)
    # Allow two successful calls
    assert cb.execute(lambda: "ok") == "ok"
    assert cb.state == CircuitState.HALF_OPEN
    assert cb.execute(lambda: "ok") == "ok"
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_half_open_failure_trips_to_open(cb_config):
    """Test that in HALF_OPEN, a failure immediately transitions to OPEN."""
    cb = CircuitBreaker("half.open.fail", cb_config)
    cb._transition_to(CircuitState.HALF_OPEN)
    def boom():
        raise RuntimeError("nope")
    with pytest.raises(RuntimeError):
        cb.execute(boom)
    assert cb.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_window_not_full(cb_config):
    """Test failure rate is 0.0 when sliding window is not full."""
    cb_config.sliding_window_size = 4
    cb_config.failure_threshold = 100
    cb_config.failure_rate_threshold = 1.0
    cb = CircuitBreaker("rate.notfull", cb_config)
    cb._record_success(0.01)
    cb._record_failure(0.02)
    cb._record_success(0.03)
    assert cb._calculate_failure_rate() == pytest.approx(0.0)


def test_circuit_breaker_calculate_failure_rate_window_full(cb_config):
    """Test failure rate when sliding window is full."""
    cb_config.sliding_window_size = 4
    cb_config.failure_threshold = 100
    cb_config.failure_rate_threshold = 1.0
    cb = CircuitBreaker("rate.full", cb_config)
    cb._record_failure(0.01)
    cb._record_failure(0.01)
    cb._record_success(0.01)
    cb._record_success(0.01)
    assert cb._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_contains_expected_fields(cb_instance):
    """Test get_health_info returns expected structure and values."""
    cb_instance.execute(lambda: "ok")
    try:
        cb_instance.execute(lambda: (_ for _ in ()).throw(ValueError("x")))
    except ValueError:
        pass
    health = cb_instance.get_health_info()
    assert health["name"] == cb_instance.name
    assert health["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert isinstance(health["failure_count"], int)
    assert isinstance(health["success_count"], int)
    assert isinstance(health["failure_rate"], float)
    metrics = health["metrics"]
    assert metrics["total_calls"] == 2
    assert metrics["successful_calls"] == 1
    assert metrics["failed_calls"] == 1
    assert metrics["average_response_time_ms"] >= 0.0
    config = health["config"]
    assert config["failure_threshold"] == cb_instance.config.failure_threshold
    assert config["success_threshold"] == cb_instance.config.success_threshold
    assert config["timeout_seconds"] == pytest.approx(cb_instance.config.timeout_seconds)


def test_distributed_coordinator_init_sets_node_id(monkeypatch):
    """Test DistributedCircuitBreakerCoordinator initialization sets node_id from env."""
    monkeypatch.setenv("NODE_ID", "node-123")
    coord = DistributedCircuitBreakerCoordinator("http://localhost:8080", sync_interval=0.01)
    assert coord.node_id == "node-123"
    assert coord.coordinator_url == "http://localhost:8080"
    assert coord.sync_interval == pytest.approx(0.01)


def test_distributed_coordinator_register_breaker_sends_registration(cb_instance):
    """Test register_breaker sends registration request to coordinator URL."""
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        coord.register_breaker(cb_instance)
        assert cb_instance.name in coord._breakers
        assert mock_urlopen.call_count == 1
        req_arg = mock_urlopen.call_args[0][0]
        assert "/circuit-breakers/register" in req_arg.full_url
        assert req_arg.method == "POST"
        assert req_arg.headers.get("Content-Type") == "application/json"
        # Ensure JSON payload decodes correctly
        payload = json.loads(req_arg.data.decode("utf-8"))
        assert payload["service"] == cb_instance.name


def test_distributed_coordinator_send_registration_swallows_urlerror(cb_instance):
    """Test _send_registration swallows URLError exceptions."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("x")):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        # Should not raise
        coord.register_breaker(cb_instance)


def test_distributed_coordinator_synchronize_states_posts_state(cb_instance, monkeypatch):
    """Test _synchronize_states posts breaker state to coordinator URL."""
    base = 4000.0
    monkeypatch.setattr(time, "time", lambda: base)
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        coord.register_breaker(cb_instance)
        coord._synchronize_states()
        # Two calls: one for register on register_breaker, one for state
        assert mock_urlopen.call_count >= 2
        # The last call is the state sync
        req_arg = mock_urlopen.call_args[0][0]
        assert "/circuit-breakers/state" in req_arg.full_url
        assert req_arg.method == "POST"
        body = json.loads(req_arg.data.decode("utf-8"))
        assert body["service"] == cb_instance.name
        assert body["state"] == cb_instance.state.value
        assert isinstance(body["health_info"], dict)
        assert body["timestamp"] == int(base * 1000)


def test_distributed_coordinator_sync_loop_runs_and_stops(cb_instance):
    """Test start_sync starts thread and _synchronize_states is called at least once, then stop."""
    coord = DistributedCircuitBreakerCoordinator("http://coord", sync_interval=0.001)
    coord.register_breaker(cb_instance)

    called = threading.Event()

    def side_effect():
        called.set()
        coord._running = False  # Stop after first call

    with patch.object(coord, "_synchronize_states", side_effect=side_effect) as mock_sync:
        coord.start_sync()
        called.wait(timeout=1.0)
        coord.stop_sync()
        assert mock_sync.call_count >= 1
        assert coord._running is False


def test_distributed_coordinator_get_cluster_state_success():
    """Test get_cluster_state returns parsed JSON on success."""
    class Resp:
        def read(self):
            return json.dumps({"ok": True}).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=Resp()) as mock_urlopen:
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        state = coord.get_cluster_state("svc")
        assert state == {"ok": True}
        req_arg = mock_urlopen.call_args[0][0]
        assert req_arg.method == "GET"
        assert "/circuit-breakers/svc/aggregate" in req_arg.full_url


def test_distributed_coordinator_get_cluster_state_failure():
    """Test get_cluster_state returns error dict when URLError occurs."""
    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=urllib.error.URLError("x")):
        coord = DistributedCircuitBreakerCoordinator("http://coord")
        state = coord.get_cluster_state("svc")
        assert state == {"error": "Failed to fetch cluster state"}


def test_circuit_breaker_decorator_executes_and_exposes_breaker(cb_config):
    """Test circuit_breaker decorator executes via breaker and exposes breaker on wrapper."""
    name = "decorated.func"
    @circuit_breaker(name, cb_config)
    def add(a, b):
        return a + b

    assert hasattr(add, "circuit_breaker")
    assert add.circuit_breaker is CircuitBreaker.get_or_create(name, cb_config)
    res = add(2, 3)
    assert res == 5
    # Metrics should reflect one call
    breaker = add.circuit_breaker
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1