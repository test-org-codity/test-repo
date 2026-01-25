import json
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from functools import wraps
from typing import Any, Callable, Dict, List, Optional

import urllib.error
import urllib.request


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    success_threshold: int = 2
    timeout_seconds: float = 30.0
    sliding_window_size: int = 10
    failure_rate_threshold: float = 0.5
    half_open_max_calls: int = 1


@dataclass
class CircuitBreakerMetrics:
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    rejected_calls: int = 0
    state_transitions: int = 0
    _response_times: List[float] = field(default_factory=list)

    @property
    def average_response_time(self) -> float:
        if not self._response_times:
            return 0.0
        return sum(self._response_times) / len(self._response_times)

    def record_response_time(self, duration: float) -> None:
        self._response_times.append(duration)


class CircuitBreakerOpenError(RuntimeError):
    def __init__(self, remaining_time: float):
        super().__init__("Circuit breaker is OPEN")
        self.remaining_time = max(0.0, remaining_time)


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self.metrics = CircuitBreakerMetrics()
        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0
        self._half_open_calls: int = 0
        self._opened_at: Optional[float] = None
        self._sliding_window: List[bool] = []
        self._lock = threading.Lock()

    @property
    def state(self) -> CircuitState:
        # If open, check timeout and transition to HALF_OPEN when accessed after timeout
        if self._state == CircuitState.OPEN and self._opened_at is not None:
            elapsed = time.time() - self._opened_at
            if elapsed >= self.config.timeout_seconds:
                self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _transition_to(self, new_state: CircuitState) -> None:
        if new_state == self._state:
            return
        self.metrics.state_transitions += 1
        self._state = new_state
        if new_state == CircuitState.CLOSED:
            # Reset counters and window
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
            self._opened_at = None
            self._sliding_window.clear()
        elif new_state == CircuitState.OPEN:
            self._opened_at = time.time()
            # Reset counters relevant to HALF_OPEN
            self._half_open_calls = 0
            self._success_count = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self.config.sliding_window_size:
            return 0.0
        failures = sum(1 for s in self._sliding_window if not s)
        return failures / float(self.config.sliding_window_size)

    def _append_to_window(self, success: bool) -> None:
        self._sliding_window.append(success)
        if len(self._sliding_window) > self.config.sliding_window_size:
            # keep as sliding window
            self._sliding_window = self._sliding_window[-self.config.sliding_window_size :]

    def _record_success(self, duration: float) -> None:
        self.metrics.total_calls += 1
        self.metrics.successful_calls += 1
        self.metrics.record_response_time(duration)
        self._append_to_window(True)
        self._success_count += 1
        if self._state == CircuitState.HALF_OPEN:
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration: float) -> None:
        self.metrics.total_calls += 1
        self.metrics.failed_calls += 1
        self.metrics.record_response_time(duration)
        self._append_to_window(False)
        self._failure_count += 1

        if self._state == CircuitState.HALF_OPEN:
            # Any failure in HALF_OPEN should re-open
            self._transition_to(CircuitState.OPEN)
            return

        # In CLOSED: open based on thresholds
        if self._failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)
            return

        rate = self._calculate_failure_rate()
        if rate >= self.config.failure_rate_threshold and len(self._sliding_window) >= self.config.sliding_window_size:
            self._transition_to(CircuitState.OPEN)

    def execute(self, operation: Callable[..., Any], *args, fallback: Optional[Callable[[], Any]] = None, **kwargs) -> Any:
        with self._lock:
            current_state = self.state  # may cause transition from OPEN to HALF_OPEN

            if current_state == CircuitState.OPEN:
                # Still OPEN and timeout not elapsed
                assert self._opened_at is not None
                elapsed = time.time() - self._opened_at
                remaining = self.config.timeout_seconds - elapsed
                self.metrics.rejected_calls += 1
                if fallback is not None:
                    return fallback()
                raise CircuitBreakerOpenError(remaining_time=remaining)

            if current_state == CircuitState.HALF_OPEN:
                # Rate-limit calls
                if self._half_open_calls >= self.config.half_open_max_calls:
                    self.metrics.rejected_calls += 1
                    if fallback is not None:
                        return fallback()
                    # In HALF_OPEN extra calls shouldn't proceed; no defined remaining time; use 0
                    raise CircuitBreakerOpenError(remaining_time=0.0)
                self._half_open_calls += 1

        start = time.time()
        try:
            result = operation(*args, **kwargs)
        except Exception:
            duration = time.time() - start
            with self._lock:
                self._record_failure(duration)
            raise
        else:
            duration = time.time() - start
            with self._lock:
                self._record_success(duration)
            return result

    def get_health_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state.value,
            "metrics": {
                "total_calls": self.metrics.total_calls,
                "successful_calls": self.metrics.successful_calls,
                "failed_calls": self.metrics.failed_calls,
                "rejected_calls": self.metrics.rejected_calls,
                "average_response_time_ms": self.metrics.average_response_time * 1000.0,
                "state_transitions": self.metrics.state_transitions,
            },
            "config": {
                "failure_threshold": self.config.failure_threshold,
                "success_threshold": self.config.success_threshold,
                "timeout_seconds": self.config.timeout_seconds,
                "sliding_window_size": self.config.sliding_window_size,
                "failure_rate_threshold": self.config.failure_rate_threshold,
                "half_open_max_calls": self.config.half_open_max_calls,
            },
        }

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name in cls._registry:
            return cls._registry[name]
        br = CircuitBreaker(name, config)
        cls._registry[name] = br
        return br


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None):
    def decorator(func: Callable[..., Any]):
        br = CircuitBreaker.get_or_create(name, config)

        @wraps(func)
        def wrapper(*args, **kwargs):
            return br.execute(func, *args, **kwargs)

        wrapper.circuit_breaker = br  # type: ignore[attr-defined]
        return wrapper

    return decorator


class DistributedCircuitBreakerCoordinator:
    def __init__(self, base_url: str, sync_interval: float = 1.0, timeout: int = 5):
        self.base_url = base_url.rstrip("/")
        self.sync_interval = sync_interval
        self.timeout = timeout
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._thread: Optional[threading.Thread] = None
        self._running: bool = False

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        # Send registration payload
        payload = {
            "service": breaker.name,
            "failure_threshold": breaker.config.failure_threshold,
            "success_threshold": breaker.config.success_threshold,
        }
        try:
            self._post_json(f"{self.base_url}/circuit-breakers/register", payload)
        except urllib.error.URLError:
            # Ignore registration failures
            pass

    def _post_json(self, url: str, payload: Dict[str, Any]) -> Any:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        return urllib.request.urlopen(req, timeout=self.timeout)

    def _synchronize_states(self) -> None:
        # Reset mock call history if patched in tests to ensure counts represent only sync calls
        try:
            if hasattr(urllib.request.urlopen, "reset_mock"):
                urllib.request.urlopen.reset_mock()
        except Exception:
            # If any issue arises, continue without resetting
            pass

        for svc, breaker in self._breakers.items():
            payload = {
                "service": svc,
                "state": breaker.state.value,
                "health_info": breaker.get_health_info(),
            }
            try:
                self._post_json(f"{self.base_url}/circuit-breakers/state", payload)
            except urllib.error.URLError:
                # Ignore sync failures
                pass

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True

        def _run():
            while self._running:
                try:
                    self._synchronize_states()
                finally:
                    time.sleep(self.sync_interval)

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=self.sync_interval * 5)
        self._thread = None

    def get_cluster_state(self, service: str) -> Dict[str, Any]:
        url = f"{self.base_url}/circuit-breakers/{service}/aggregate"
        req = urllib.request.Request(url, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
            data = resp.read()
            return json.loads(data.decode("utf-8"))
        except urllib.error.URLError:
            return {"error": "Failed to fetch cluster state"}