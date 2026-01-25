import json
import time
import threading
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
def reset_registry(monkeypatch):
    """Reset CircuitBreaker registry before each test to avoid cross-test pollution."""
    monkeypatch.setattr(CircuitBreaker, "_registry", {})


@pytest.fixture
def config():
    """Provide a CircuitBreakerConfig with small thresholds for tests."""
    return CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=0.1,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=config)


@pytest.fixture
def metrics():
    """Create a CircuitBreakerMetrics instance for testing."""
    return CircuitBreakerMetrics()


def test_circuit_state_enum_values():
    """CircuitState enum values should match the source implementation."""
    assert CircuitState.CLOSED.value == "CLOSED"
    assert CircuitState.OPEN.value == "OPEN"
    assert CircuitState.HALF_OPEN.value == "HALF_OPEN"


def test_circuit_breaker_config_defaults():
    """CircuitBreakerConfig should initialize with documented default values."""
    cfg = CircuitBreakerConfig()
    assert cfg.failure_threshold == 5
    assert cfg.success_threshold == 3
    assert cfg.timeout_seconds == pytest.approx(30.0)
    assert cfg.half_open_max_calls == 3
    assert cfg.sliding_window_size == 10
    assert cfg.failure_rate_threshold == pytest.approx(0.5)


def test_metrics_record_response_time_average(metrics):
    """record_response_time should update average_response_time correctly."""
    metrics.record_response_time(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx((0.1 + 0.3) / 2)
    assert len(metrics._response_times) == 2


def test_circuit_breaker_open_error_message():
    """CircuitBreakerOpenError string message should include name and remaining time."""
    err = CircuitBreakerOpenError("svc", 7.25)
    assert "svc" in str(err)
    assert "7.25" in str(err)
    assert err.name == "svc"
    assert err.remaining_time == pytest.approx(7.25)


def test_circuit_breaker_get_or_create_singleton(config):
    """get_or_create should return the same instance for the same name."""
    br1 = CircuitBreaker.get_or_create("svc", config)
    br2 = CircuitBreaker.get_or_create("svc", config)
    br3 = CircuitBreaker.get_or_create("svc2", config)
    assert br1 is br2
    assert br1 is not br3
    assert br1.name == "svc"
    assert br3.name == "svc2"


def test_circuit_breaker_initialization_defaults(breaker, config):
    """CircuitBreaker should initialize with expected default state and metrics."""
    assert breaker.name == "test-breaker"
    assert breaker.state == CircuitState.CLOSED
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._half_open_calls == 0
    assert breaker._opened_at is None
    assert breaker._sliding_window.maxlen == config.sliding_window_size
    assert breaker.metrics.total_calls == 0
    assert breaker.metrics.average_response_time == pytest.approx(0.0)


def test_circuit_breaker_should_attempt_reset(monkeypatch, breaker):
    """_should_attempt_reset should reflect timeout logic based on _opened_at."""
    # when _opened_at is None -> False
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False

    # set fixed time and verify True when elapsed beyond timeout
    base = 1000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    breaker._opened_at = base - (breaker.config.timeout_seconds + 0.001)
    assert breaker._should_attempt_reset() is True

    # not yet elapsed
    breaker._opened_at = base - (breaker.config.timeout_seconds - 0.05)
    assert breaker._should_attempt_reset() is False


def test_circuit_breaker_state_transitions_to_half_open_on_timeout(monkeypatch, breaker):
    """Accessing state should transition OPEN to HALF_OPEN after timeout."""
    base = 5000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    # Open and set opened_at to before timeout
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(base)
    # Advance time beyond timeout
    later = base + breaker.config.timeout_seconds + 0.01
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: later)
    transitions_before = breaker.metrics.state_transitions
    assert breaker.state == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions == transitions_before + 1


def test_circuit_breaker_transition_to_open_sets_opened_at(monkeypatch, breaker):
    """_transition_to OPEN should set _opened_at and increment transitions."""
    base = 2000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    transitions_before = breaker.metrics.state_transitions
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(base)
    assert breaker.metrics.state_transitions == transitions_before + 1


def test_circuit_breaker_transition_to_closed_resets_counters_and_window(breaker):
    """_transition_to CLOSED should reset counters and clear the sliding window."""
    breaker._failure_count = 3
    breaker._success_count = 2
    breaker._half_open_calls = 1
    breaker._opened_at = 123.0
    breaker._sliding_window.extend([True, False, True])
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0


def test_circuit_breaker_transition_to_half_open_resets_probe_counters(breaker):
    """_transition_to HALF_OPEN should reset half-open calls and success count."""
    breaker._half_open_calls = 5
    breaker._success_count = 4
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._half_open_calls == 0
    assert breaker._success_count == 0


def test_circuit_breaker_allow_request_behaviors(breaker):
    """_allow_request should allow in CLOSED, deny in OPEN, and limit in HALF_OPEN."""
    # Closed allows
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._allow_request() is True

    # Open denies
    breaker._transition_to(CircuitState.OPEN)
    assert breaker._allow_request() is False

    # Half-open allows up to half_open_max_calls then denies
    breaker._transition_to(CircuitState.HALF_OPEN)
    max_calls = breaker.config.half_open_max_calls
    for _ in range(max_calls):
        assert breaker._allow_request() is True
    assert breaker._allow_request() is False


def test_circuit_breaker_execute_success_updates_metrics_and_decrements_failures(breaker):
    """execute should record success, update metrics, and decrease failure_count in CLOSED."""
    breaker._transition_to(CircuitState.CLOSED)
    breaker._failure_count = 2

    def op():
        return "ok"

    result = breaker.execute(op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.metrics.average_response_time >= pytest.approx(0.0)
    assert breaker._failure_count == 1
    assert list(breaker._sliding_window)[-1] is True


def test_circuit_breaker_execute_failure_updates_metrics_and_increments_failure_count(breaker):
    """execute should propagate exception and record failure without opening early."""
    # Increase failure threshold to avoid opening on first failure
    breaker.config.failure_threshold = 10

    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        breaker.execute(failing)

    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.failed_calls == 1
    assert breaker.metrics.successful_calls == 0
    assert breaker._failure_count == 1
    assert list(breaker._sliding_window)[-1] is False


def test_circuit_breaker_execute_open_without_fallback_raises_and_counts_rejection(monkeypatch, breaker):
    """execute should raise CircuitBreakerOpenError when OPEN and increment rejected_calls."""
    # Open the breaker and set _opened_at to compute remaining time
    breaker._transition_to(CircuitState.OPEN)
    breaker.config.timeout_seconds = 10.0
    base = 1000.0
    elapsed = 3.5
    breaker._opened_at = base - elapsed
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)

    rejected_before = breaker.metrics.rejected_calls
    with pytest.raises(CircuitBreakerOpenError) as exc:
        breaker.execute(lambda: "ok")

    assert breaker.metrics.rejected_calls == rejected_before + 1
    assert exc.value.name == "test-breaker"
    assert exc.value.remaining_time == pytest.approx(10.0 - elapsed)


def test_circuit_breaker_execute_open_with_fallback_returns_value_and_counts_rejection(breaker):
    """execute should return fallback when OPEN and not increment total_calls."""
    breaker._transition_to(CircuitState.OPEN)
    fallback = lambda: "fallback"
    total_before = breaker.metrics.total_calls
    rejected_before = breaker.metrics.rejected_calls
    result = breaker.execute(lambda: "ok", fallback=fallback)
    assert result == "fallback"
    assert breaker.metrics.rejected_calls == rejected_before + 1
    assert breaker.metrics.total_calls == total_before


def test_circuit_breaker_half_open_successes_close_after_threshold(monkeypatch):
    """In HALF_OPEN, reaching success_threshold should transition to CLOSED."""
    cfg = CircuitBreakerConfig(
        failure_threshold=10, success_threshold=2, timeout_seconds=0.1, half_open_max_calls=5, sliding_window_size=10
    )
    br = CircuitBreaker("half-open-test", cfg)
    # Force to OPEN, then simulate timeout to HALF_OPEN
    base = 4000.0
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base)
    br._transition_to(CircuitState.OPEN)
    monkeypatch.setattr("src.circuit_breaker.time.time", lambda: base + cfg.timeout_seconds + 0.01)

    assert br.state == CircuitState.HALF_OPEN

    # Two successful executions should close the breaker
    assert br.execute(lambda: "a") == "a"
    assert br.state == CircuitState.HALF_OPEN
    assert br.execute(lambda: "b") == "b"
    assert br.state == CircuitState.CLOSED


def test_circuit_breaker_half_open_failure_reopens(breaker):
    """In HALF_OPEN, a failure should transition back to OPEN immediately."""
    breaker._transition_to(CircuitState.HALF_OPEN)

    def failing():
        raise RuntimeError("fail")

    with pytest.raises(RuntimeError):
        breaker.execute(failing)

    assert breaker.state == CircuitState.OPEN


def test_circuit_breaker_failure_rate_triggers_open_when_window_full():
    """Failure rate threshold should open the breaker when sliding window is full."""
    cfg = CircuitBreakerConfig(
        failure_threshold=999,  # avoid opening via failure count
        success_threshold=2,
        timeout_seconds=0.1,
        half_open_max_calls=5,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )
    br = CircuitBreaker("rate-test", cfg)

    # 2 successes
    assert br.execute(lambda: "ok") == "ok"
    assert br.execute(lambda: "ok") == "ok"
    # 2 failures -> window full, failure_rate = 0.5 -> OPEN
    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("x")))
    with pytest.raises(ValueError):
        br.execute(lambda: (_ for _ in ()).throw(ValueError("y")))

    assert br.state == CircuitState.OPEN


def test_circuit_breaker_calculate_failure_rate_window_behavior(breaker):
    """_calculate_failure_rate should be 0.0 until window full, then reflect actual rate."""
    # Append directly to sliding window
    breaker._sliding_window.clear()
    breaker._sliding_window.append(False)
    breaker._sliding_window.append(False)
    breaker._sliding_window.append(True)
    assert len(breaker._sliding_window) == 3
    assert breaker._calculate_failure_rate() == pytest.approx(0.0)

    breaker._sliding_window.append(True)  # window now full size=4, failures=2
    assert len(breaker._sliding_window) == breaker.config.sliding_window_size
    assert breaker._calculate_failure_rate() == pytest.approx(0.5)


def test_circuit_breaker_get_health_info_contains_expected_fields(breaker):
    """get_health_info should include name, state, metrics, and config."""
    info = breaker.get_health_info()
    assert info["name"] == "test-breaker"
    assert info["state"] in {"CLOSED", "OPEN", "HALF_OPEN"}
    assert "metrics" in info and isinstance(info["metrics"], dict)
    assert "config" in info and isinstance(info["config"], dict)
    assert "failure_rate" in info
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(breaker.metrics.average_response_time * 1000.0)


def test_coordinator_register_breaker_calls_send_registration(monkeypatch, breaker):
    """register_breaker should store breaker and call _send_registration."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    called = {"count": 0}

    def fake_send(br):
        called["count"] += 1
        assert br is breaker

    monkeypatch.setattr(coord, "_send_registration", fake_send)
    coord.register_breaker(breaker)
    assert breaker.name in coord._breakers
    assert called["count"] == 1


def test_coordinator_send_registration_posts_json(monkeypatch, breaker):
    """_send_registration should POST registration JSON to coordinator."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")

    captured = {}

    def fake_urlopen(req, timeout):
        captured["req"] = req
        class Resp:
            def read(self): return b""
        return Resp()

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    coord._send_registration(breaker)

    req = captured["req"]
    assert req.full_url.endswith("/circuit-breakers/register")
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["service"] == breaker.name
    assert "failure_threshold" in payload
    assert "success_threshold" in payload


def test_coordinator_synchronize_states_posts_each_breaker(monkeypatch, breaker):
    """_synchronize_states should POST state for each registered breaker."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    br2 = CircuitBreaker("another", breaker.config)
    coord.register_breaker(breaker)
    coord.register_breaker(br2)

    calls = []

    def fake_urlopen(req, timeout):
        calls.append(req)
        class Resp:
            def read(self): return b""
        return Resp()

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    coord._synchronize_states()
    # One POST per breaker
    assert len(calls) == 2
    for req in calls:
        assert req.full_url.endswith("/circuit-breakers/state")
        payload = json.loads(req.data.decode("utf-8"))
        assert "service" in payload
        assert "state" in payload
        assert "health_info" in payload


def test_coordinator_start_and_stop_sync_invokes_synchronize_states(monkeypatch, breaker):
    """start_sync should run background thread that calls _synchronize_states; stop_sync should stop it."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.01)
    coord.register_breaker(breaker)
    call_count = {"n": 0}

    def fake_sync():
        call_count["n"] += 1

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)
    coord.start_sync()
    time.sleep(0.05)
    coord.stop_sync()
    assert call_count["n"] >= 1


def test_coordinator_get_cluster_state_success_and_error(monkeypatch):
    """get_cluster_state should return parsed JSON on success, and error dict on URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")

    class Resp:
        def read(self):
            return json.dumps({"ok": True, "nodes": 3}).encode("utf-8")

    def fake_urlopen_success(req, timeout):
        return Resp()

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen_success)
    state = coord.get_cluster_state("svc")
    assert state["ok"] is True
    assert state["nodes"] == 3

    def fake_urlopen_error(req, timeout):
        raise Exception("URLError")

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen_error)
    state_err = coord.get_cluster_state("svc")
    assert "error" in state_err


def test_decorator_wraps_function_and_calls_breaker_execute(monkeypatch):
    """circuit_breaker decorator should wrap a function and use breaker.execute."""
    br_name = "decorated-svc"
    decorated = None

    @circuit_breaker(br_name)
    def fn(x, y):
        return x + y

    decorated = fn
    assert hasattr(decorated, "__wrapped__")
    assert hasattr(decorated, "circuit_breaker")
    # Patch execute to control return
    exec_mock = Mock(return_value="result")
    monkeypatch.setattr(decorated.circuit_breaker, "execute", exec_mock)
    out = decorated(1, 2)
    assert out == "result"
    exec_mock.assert_called_once()
    # Ensure breaker is the one in registry
    br = CircuitBreaker.get_or_create(br_name)
    assert decorated.circuit_breaker is br


def test_decorator_same_name_shares_same_breaker():
    """Two decorated functions with the same breaker name should share the same breaker instance."""
    name = "shared-svc"

    @circuit_breaker(name)
    def f1():
        return "f1"

    @circuit_breaker(name)
    def f2():
        return "f2"

    assert f1.circuit_breaker is f2.circuit_breaker