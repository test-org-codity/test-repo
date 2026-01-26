import json
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from enum import Enum
from functools import wraps
from typing import Any, Callable, Dict, List, Optional


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    success_threshold: int = 3
    timeout_seconds: float = 30.0
    half_open_max_calls: int = 3
    sliding_window_size: int = 10
    failure_rate_threshold: float = 0.5


@dataclass
class CircuitBreakerMetrics:
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    rejected_calls: int = 0
    state_transitions: int = 0
    average_response_time: float = 0.0
    _rt_count: int = field(default=0, init=False, repr=False)

    def record_response_time(self, seconds: float) -> None:
        # Incremental average to avoid storing all samples
        self._rt_count += 1
        if self._rt_count == 1:
            self.average_response_time = seconds
        else:
            self.average_response_time += (seconds - self.average_response_time) / self._rt_count


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = remaining_time
        super().__init__(
            f"Circuit breaker '{name}' is open. Retry after {remaining_time:.2f}s"
        )


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self.metrics = CircuitBreakerMetrics()
        self._state: CircuitState = CircuitState.CLOSED
        self._opened_at: Optional[float] = None  # wall clock time (time.time)
        self._opened_at_mono: Optional[float] = None  # monotonic reference for elapsed calculation
        self._failure_count: int = 0  # consecutive failures
        self._success_count: int = 0  # successive successes in HALF_OPEN
        self._half_open_calls: int = 0
        self._sliding_window: List[bool] = []

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name not in cls._registry:
            cls._registry[name] = CircuitBreaker(name, config)
        return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        # Auto-transition OPEN -> HALF_OPEN when timeout elapsed
        if self._state is CircuitState.OPEN and self._should_attempt_reset():
            self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at_mono is None:
            return False
        elapsed = time.monotonic() - self._opened_at_mono
        return elapsed >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState) -> None:
        if self._state == new_state:
            return
        self._state = new_state
        self.metrics.state_transitions += 1
        if new_state is CircuitState.OPEN:
            now_time = time.time()
            now_mono = time.monotonic()
            self._opened_at = now_time
            self._opened_at_mono = now_mono
            # When opening, reset HALF_OPEN counters
            self._half_open_calls = 0
            self._success_count = 0
        elif new_state is CircuitState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
            self._opened_at = None
            self._opened_at_mono = None
            self._sliding_window.clear()
        elif new_state is CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0

    def _allow_request(self) -> bool:
        # Accessing state may auto-transition OPEN->HALF_OPEN if timeout elapsed
        current = self.state
        if current is CircuitState.CLOSED:
            return True
        if current is CircuitState.OPEN:
            return False
        # HALF_OPEN
        if self._half_open_calls < self.config.half_open_max_calls:
            self._half_open_calls += 1
            return True
        return False

    def _record_success(self, duration_s: float) -> None:
        # Update metrics and internal counters; do not increment total_calls here
        self.metrics.successful_calls += 1
        self.metrics.record_response_time(duration_s)
        # Reset failure count on any success
        self._failure_count = 0
        # Append to sliding window
        self._append_to_window(True)

        if self._state is CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration_s: float) -> None:
        # Update metrics and internal counters; do not increment total_calls here
        self.metrics.failed_calls += 1
        self.metrics.record_response_time(duration_s)
        self._failure_count += 1
        self._success_count = 0  # reset success streak
        self._append_to_window(False)

        # Behavior in HALF_OPEN: any failure -> OPEN
        if self._state is CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        # Count-based opening
        if self._failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)
            return

        # Failure-rate based opening: only when window is full
        rate = self._calculate_failure_rate()
        if rate >= self.config.failure_rate_threshold and len(self._sliding_window) >= self.config.sliding_window_size:
            self._transition_to(CircuitState.OPEN)

    def _append_to_window(self, success: bool) -> None:
        self._sliding_window.append(success)
        if len(self._sliding_window) > self.config.sliding_window_size:
            self._sliding_window.pop(0)

    def _calculate_failure_rate(self) -> float:
        size = self.config.sliding_window_size
        if len(self._sliding_window) < size or size == 0:
            return 0.0
        failures = sum(1 for s in self._sliding_window if not s)
        return failures / float(size)

    def execute(self, func: Callable[[], Any], fallback: Optional[Callable[[], Any]] = None) -> Any:
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            # Compute remaining time in open state
            remaining = 0.0
            if self._opened_at_mono is not None:
                elapsed = time.monotonic() - self._opened_at_mono
                remaining = max(0.0, self.config.timeout_seconds - elapsed)
            if fallback is not None:
                return fallback()
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.perf_counter()
        try:
            result = func()
        except Exception:
            duration = time.perf_counter() - start
            # Only count towards total_calls if we actually executed the function
            self.metrics.total_calls += 1
            self._record_failure(duration)
            raise
        else:
            duration = time.perf_counter() - start
            self.metrics.total_calls += 1
            self._record_success(duration)
            return result

    def get_health_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "success_count": self._success_count,
            "failure_rate": self._calculate_failure_rate(),
            "metrics": {
                "successful_calls": self.metrics.successful_calls,
                "failed_calls": self.metrics.failed_calls,
                "rejected_calls": self.metrics.rejected_calls,
                "total_calls": self.metrics.total_calls,
                "average_response_time_ms": self.metrics.average_response_time * 1000.0,
                "state_transitions": self.metrics.state_transitions,
            },
            "config": {
                "failure_threshold": self.config.failure_threshold,
                "success_threshold": self.config.success_threshold,
                "timeout_seconds": self.config.timeout_seconds,
                "half_open_max_calls": self.config.half_open_max_calls,
                "sliding_window_size": self.config.sliding_window_size,
                "failure_rate_threshold": self.config.failure_rate_threshold,
            },
        }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, base_url: str, sync_interval: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running: bool = False
        self._sync_thread: Optional[threading.Thread] = None
        self._sync_interval = sync_interval

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        # Send registration POST
        url = f"{self.base_url}/circuit-breakers/register"
        data = json.dumps({"name": breaker.name}).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req)
        except Exception:
            # Swallow errors in coordination layer to not break application flow
            pass

    def _synchronize_states(self) -> None:
        for br in self._breakers.values():
            url = f"{self.base_url}/circuit-breakers/state"
            payload = {"name": br.name, "state": br.state.value}
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req)
            except Exception:
                pass

    def get_cluster_state(self, service_name: str) -> Dict[str, Any]:
        url = f"{self.base_url}/circuit-breakers/{service_name}/aggregate"
        req = urllib.request.Request(url, method="GET")
        try:
            resp = urllib.request.urlopen(req)
            body = resp.read()
            return json.loads(body.decode("utf-8"))
        except Exception:
            return {"error": "Failed to fetch cluster state"}

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True

        def _loop():
            while self._running:
                try:
                    self._synchronize_states()
                finally:
                    time.sleep(self._sync_interval)

        self._sync_thread = threading.Thread(target=_loop, daemon=True)
        self._sync_thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._sync_thread is not None:
            self._sync_thread.join(timeout=self._sync_interval * 5)
            # Keep the thread object for inspection in tests
            # Do not clear it


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    br = CircuitBreaker.get_or_create(name, config or CircuitBreakerConfig())

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return br.execute(lambda: func(*args, **kwargs))

        # Expose breaker for testing/introspection
        wrapper.circuit_breaker = br  # type: ignore[attr-defined]
        return wrapper

    return decorator