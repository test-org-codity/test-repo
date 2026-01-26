import json
import threading
import types
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
def reset_registry():
    """Reset CircuitBreaker registry before each test to ensure isolation."""
    CircuitBreaker._registry.clear()


@pytest.fixture
def default_config():
    """Provide a default CircuitBreakerConfig for tests."""
    return CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=30.0,
        half_open_max_calls=2,
        sliding_window_size=4,
        failure_rate_threshold=0.5,
    )


@pytest.fixture
def breaker(default_config):
    """Create a CircuitBreaker instance for testing."""
    return CircuitBreaker(name="test-breaker", config=default_config)


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


def test_metrics_record_response_time_updates_average():
    """Test CircuitBreakerMetrics.record_response_time updates average correctly."""
    metrics = CircuitBreakerMetrics()
    metrics.record_response_time(0.1)
    assert metrics.average_response_time == pytest.approx(0.1)
    metrics.record_response_time(0.3)
    assert metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_get_or_create_singleton(default_config):
    """Test get_or_create returns the same instance for the same name."""
    b1 = CircuitBreaker.get_or_create("svc", default_config)
    b2 = CircuitBreaker.get_or_create("svc", CircuitBreakerConfig(failure_threshold=99))
    assert b1 is b2
    assert b1.name == "svc"


def test_circuit_breaker_execute_success_in_closed(breaker, monkeypatch):
    """Test execute successful call in CLOSED state records metrics and remains CLOSED."""
    calls = {"time": 100.0}

    def fake_time():
        return calls["time"]

    monkeypatch.setattr("time.time", fake_time)
    def op():
        calls["time"] += 0.2
        return "ok"

    result = breaker.execute(op)
    assert result == "ok"
    assert breaker.metrics.total_calls == 1
    assert breaker.metrics.successful_calls == 1
    assert breaker.metrics.failed_calls == 0
    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.average_response_time == pytest.approx(0.2)


def test_circuit_breaker_execute_failure_transitions_to_open_on_threshold(monkeypatch):
    """Test failures reaching failure_threshold transition breaker to OPEN."""
    cfg = CircuitBreakerConfig(
        failure_threshold=2,
        success_threshold=2,
        timeout_seconds=30.0,
        half_open_max_calls=2,
        sliding_window_size=10,
        failure_rate_threshold=1.0,  # avoid rate-based opening
    )
    breaker = CircuitBreaker("fail-breaker", cfg)

    t = {"time": 10.0}

    def fake_time():
        return t["time"]

    monkeypatch.setattr("time.time", fake_time)

    def fail_op():
        t["time"] += 0.01
        raise RuntimeError("failure")

    with pytest.raises(RuntimeError):
        breaker.execute(fail_op)
    with pytest.raises(RuntimeError):
        breaker.execute(fail_op)

    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls == 2
    assert breaker._opened_at == pytest.approx(t["time"], rel=1e-6)


def test_circuit_breaker_allow_request_denied_when_open_no_fallback(breaker, monkeypatch):
    """Test execute rejects when OPEN without fallback and raises CircuitBreakerOpenError."""
    now = 50.0
    monkeypatch.setattr("time.time", lambda: now)
    breaker._transition_to(CircuitState.OPEN)  # sets _opened_at to now
    op = Mock()

    with pytest.raises(CircuitBreakerOpenError) as exc:
        breaker.execute(op)

    assert op.call_count == 0
    assert breaker.metrics.rejected_calls == 1
    assert exc.value.name == breaker.name
    assert exc.value.remaining_time >= 0.0


def test_circuit_breaker_allow_request_open_with_fallback(breaker, monkeypatch):
    """Test execute uses fallback when OPEN and increments rejected_calls."""
    now = 100.0
    monkeypatch.setattr("time.time", lambda: now)
    breaker._transition_to(CircuitState.OPEN)
    op = Mock()
    fallback = Mock(return_value="fb")

    result = breaker.execute(op, fallback=fallback)
    assert result == "fb"
    assert op.call_count == 0
    assert fallback.call_count == 1
    assert breaker.metrics.rejected_calls == 1


def test_circuit_breaker_open_transitions_to_half_open_when_timeout_elapsed(breaker, monkeypatch):
    """Test state property transitions from OPEN to HALF_OPEN when timeout elapsed."""
    base = {"time": 0.0}
    breaker.config.timeout_seconds = 30.0

    def fake_time():
        return base["time"]

    monkeypatch.setattr("time.time", fake_time)
    breaker._transition_to(CircuitState.OPEN)
    base["time"] = 31.0  # beyond timeout

    # Accessing state should cause transition
    st = breaker.state
    assert st == CircuitState.HALF_OPEN
    assert breaker.metrics.state_transitions >= 2  # OPEN then HALF_OPEN


def test_circuit_breaker_half_open_allows_limited_calls(breaker):
    """Test HALF_OPEN allows up to half_open_max_calls and then rejects."""
    breaker._transition_to(CircuitState.HALF_OPEN)
    breaker.config.half_open_max_calls = 2

    allowed1 = breaker._allow_request()
    allowed2 = breaker._allow_request()
    allowed3 = breaker._allow_request()

    assert allowed1 is True
    assert allowed2 is True
    assert allowed3 is False


def test_circuit_breaker_half_open_success_threshold_closes(breaker, monkeypatch):
    """Test successful calls in HALF_OPEN reaching success_threshold close the breaker."""
    breaker.config.success_threshold = 2
    breaker.config.half_open_max_calls = 5
    base = {"time": 200.0}

    def fake_time():
        return base["time"]

    monkeypatch.setattr("time.time", fake_time)

    breaker._transition_to(CircuitState.HALF_OPEN)

    def op():
        base["time"] += 0.05
        return "ok"

    # Two successful calls
    assert breaker.execute(op) == "ok"
    assert breaker.execute(op) == "ok"

    assert breaker.state == CircuitState.CLOSED
    assert breaker.metrics.successful_calls >= 2


def test_circuit_breaker_half_open_failure_reopens(breaker, monkeypatch):
    """Test a failure in HALF_OPEN transitions the breaker back to OPEN."""
    base = {"time": 300.0}

    def fake_time():
        return base["time"]

    monkeypatch.setattr("time.time", fake_time)
    breaker._transition_to(CircuitState.HALF_OPEN)

    def op():
        base["time"] += 0.01
        raise ValueError("boom")

    with pytest.raises(ValueError):
        breaker.execute(op)

    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics.failed_calls >= 1


def test_circuit_breaker_record_success_decrements_failure_count_in_closed(breaker):
    """Test _record_success decrements failure_count in CLOSED state down to zero."""
    breaker._failure_count = 3
    breaker._record_success(0.1)
    assert breaker._failure_count == 2
    breaker._record_success(0.1)
    breaker._record_success(0.1)
    assert breaker._failure_count == 0


def test_circuit_breaker_calculate_failure_rate_requires_full_window(monkeypatch):
    """Test _calculate_failure_rate returns 0.0 until sliding window is full, then computes rate."""
    cfg = CircuitBreakerConfig(
        sliding_window_size=4,
        failure_rate_threshold=1.0,
        failure_threshold=999,
    )
    b = CircuitBreaker("rate-breaker", cfg)

    # Add three entries, less than window size
    b._record_failure(0.01)
    b._record_success(0.02)
    b._record_failure(0.03)
    assert b._calculate_failure_rate() == pytest.approx(0.0)

    # Fourth entry fills window: 3 failures, 1 success -> 0.75
    b._record_failure(0.04)
    assert b._calculate_failure_rate() == pytest.approx(0.75)


def test_circuit_breaker_failure_rate_opens_when_threshold_exceeded(monkeypatch):
    """Test breaker opens when failure rate threshold exceeded after window fills."""
    cfg = CircuitBreakerConfig(
        failure_threshold=100,        # avoid count-based trip
        failure_rate_threshold=0.5,   # 50%
        sliding_window_size=4,
    )
    b = CircuitBreaker("rate-open", cfg)

    # Sequence: S, F, F, F -> failure rate 0.75 on 4th record
    b._record_success(0.01)
    assert b.state == CircuitState.CLOSED
    b._record_failure(0.01)
    assert b.state == CircuitState.CLOSED
    b._record_failure(0.01)
    assert b.state == CircuitState.CLOSED
    b._record_failure(0.01)
    assert b.state == CircuitState.OPEN


def test_circuit_breaker_get_health_info_structure_and_values(monkeypatch):
    """Test get_health_info returns expected structure and computed values."""
    cfg = CircuitBreakerConfig(failure_threshold=999, sliding_window_size=10)
    b = CircuitBreaker("health", cfg)

    times = [100.0, 100.1, 200.0, 200.3]
    it = iter(times)
    monkeypatch.setattr("time.time", lambda: next(it))

    def op_ok():
        return "ok"

    def op_fail():
        raise RuntimeError("x")

    # One success (0.1s), one failure (0.3s)
    assert b.execute(op_ok) == "ok"
    with pytest.raises(RuntimeError):
        b.execute(op_fail)

    info = b.get_health_info()
    assert info["name"] == "health"
    assert info["state"] == CircuitState.CLOSED.value
    assert "metrics" in info and "config" in info
    assert info["metrics"]["total_calls"] == 2
    assert info["metrics"]["successful_calls"] == 1
    assert info["metrics"]["failed_calls"] == 1
    assert info["metrics"]["average_response_time_ms"] == pytest.approx(200.0)  # (0.1+0.3)/2 * 1000


def test_circuit_breaker_should_attempt_reset(breaker, monkeypatch):
    """Test _should_attempt_reset returns True only after timeout has elapsed."""
    breaker._opened_at = None
    assert breaker._should_attempt_reset() is False

    now = {"t": 10.0}
    breaker._opened_at = 0.0
    breaker.config.timeout_seconds = 30.0

    def fake_time():
        return now["t"]

    monkeypatch.setattr("time.time", fake_time)
    assert breaker._should_attempt_reset() is False
    now["t"] = 30.0
    assert breaker._should_attempt_reset() is True


def test_circuit_breaker_transition_to_resets_counters(breaker, monkeypatch):
    """Test _transition_to sets timestamps and resets counters appropriately."""
    base = {"time": 0.0}
    monkeypatch.setattr("time.time", lambda: base["time"])

    breaker._failure_count = 5
    breaker._success_count = 5
    breaker._sliding_window.extend([True, False])

    breaker._transition_to(CircuitState.OPEN)
    assert breaker._opened_at == pytest.approx(base["time"])
    base["time"] = 1.0
    breaker._transition_to(CircuitState.HALF_OPEN)
    assert breaker._success_count == 0
    assert breaker._half_open_calls == 0
    base["time"] = 2.0
    breaker._transition_to(CircuitState.CLOSED)
    assert breaker._failure_count == 0
    assert breaker._success_count == 0
    assert breaker._opened_at is None
    assert len(breaker._sliding_window) == 0


def test_distributed_coordinator_register_breaker_sends_registration(breaker):
    """Test registering a breaker sends registration request."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    with patch("src.circuit_breaker.urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = Mock()
        coord.register_breaker(breaker)
        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert req.full_url.endswith("/circuit-breakers/register")
        assert req.get_method() == "POST"
        assert req.headers["Content-Type"] == "application/json"


def test_distributed_coordinator_synchronize_states_posts_for_each_breaker(monkeypatch):
    """Test _synchronize_states posts state for each registered breaker with expected payload."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")
    cfg = CircuitBreakerConfig()
    b1 = CircuitBreaker("svc1", cfg)
    b2 = CircuitBreaker("svc2", cfg)
    coord.register_breaker(b1)
    coord.register_breaker(b2)

    sent = []

    def fake_urlopen(req, timeout=5):
        data = req.data
        payload = json.loads(data.decode("utf-8"))
        sent.append((req.full_url, payload))
        m = Mock()
        return m

    monkeypatch.setattr("src.circuit_breaker.urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr("time.time", lambda: 123.456)

    coord._synchronize_states()
    assert len(sent) == 2
    for url, payload in sent:
        assert url.endswith("/circuit-breakers/state")
        assert payload["service"] in {"svc1", "svc2"}
        assert "state" in payload and "failure_count" in payload and "timestamp" in payload
        assert payload["timestamp"] == int(123.456 * 1000)
        assert isinstance(payload["health_info"], dict)


def test_distributed_coordinator_get_cluster_state_success_and_failure():
    """Test get_cluster_state returns JSON on success and error dict on URLError."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator")

    class FakeResponse:
        def read(self):
            return json.dumps({"ok": True}).encode("utf-8")

    with patch("src.circuit_breaker.urllib.request.urlopen", return_value=FakeResponse()):
        data = coord.get_cluster_state("svc")
        assert data == {"ok": True}

    with patch("src.circuit_breaker.urllib.request.urlopen", side_effect=URLError("x")):
        data = coord.get_cluster_state("svc")
        assert "error" in data


def test_distributed_coordinator_start_stop_sync(monkeypatch):
    """Test start_sync launches a thread that runs _synchronize_states and stop_sync joins it."""
    coord = DistributedCircuitBreakerCoordinator("http://coordinator", sync_interval=0.0)
    called = {"n": 0}

    def fake_sync():
        called["n"] += 1
        coord._running = False  # stop after first iteration

    monkeypatch.setattr(coord, "_synchronize_states", fake_sync)

    coord.start_sync()
    coord.stop_sync()
    assert called["n"] >= 1
    assert coord._running is False


def test_circuit_breaker_open_error_attributes():
    """Test CircuitBreakerOpenError stores attributes and formats message."""
    err = CircuitBreakerOpenError("name1", 5.5)
    assert err.name == "name1"
    assert err.remaining_time == pytest.approx(5.5)
    assert "name1" in str(err)
    assert "5.50" in str(err) or "5.5" in str(err)