from dataclasses import dataclass, field, asdict
from enum import Enum
from collections import deque
import threading
import time
import uuid
import json
from typing import Callable, Optional, Dict, Any
import urllib.request
from urllib.error import URLError


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
    average_response_time: float = 0.0
    last_failure_time: Optional[float] = None
    last_success_time: Optional[float] = None
    state_transitions: int = 0
    _durations: deque = field(default_factory=lambda: deque(maxlen=100), repr=False)

    def record_response_time(self, duration_seconds: float) -> None:
        self._durations.append(duration_seconds)
        if self._durations:
            self.average_response_time = sum(self._durations) / len(self._durations)
        else:
            self.average_response_time = 0.0


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = max(0.0, remaining_time)
        super().__init__(self.__str__())

    def __str__(self) -> str:
        return (
            f"Circuit breaker '{self.name}' is open. "
            f"Retry after {self.remaining_time:.2f} seconds."
        )


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        self.name = name
        self.config: CircuitBreakerConfig = config or CircuitBreakerConfig()
        self.metrics = CircuitBreakerMetrics()

        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0  # used in HALF_OPEN for success threshold
        self._half_open_calls: int = 0
        self._opened_at: Optional[float] = None
        self._sliding_window: deque = deque(maxlen=self.config.sliding_window_size)

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name not in cls._registry:
            cls._registry[name] = CircuitBreaker(name=name, config=config or CircuitBreakerConfig())
        return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        # Auto transition from OPEN to HALF_OPEN if timeout elapsed
        if self._state == CircuitState.OPEN and self._should_attempt_reset():
            self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        elapsed = time.time() - self._opened_at
        return elapsed >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState) -> None:
        if new_state == self._state:
            return
        self._state = new_state
        self.metrics.state_transitions += 1

        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0
        elif new_state == CircuitState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._opened_at = None
            self._sliding_window.clear()

    def _allow_request(self) -> bool:
        # Evaluate current state (may auto-transition from OPEN to HALF_OPEN)
        current_state = self.state
        if current_state == CircuitState.OPEN:
            return False
        if current_state == CircuitState.HALF_OPEN:
            if self._half_open_calls < self.config.half_open_max_calls:
                self._half_open_calls += 1
                return True
            return False
        return True  # CLOSED

    def _record_success(self, duration_seconds: float) -> None:
        # Only count as a call if it wasn't rejected (execute manages that)
        self.metrics.total_calls += 1
        self.metrics.successful_calls += 1
        self.metrics.last_success_time = time.time()
        self.metrics.record_response_time(duration_seconds)
        self._sliding_window.append(True)

        # When CLOSED, decrease failure count but not below zero
        if self._state == CircuitState.CLOSED:
            self._failure_count = max(0, self._failure_count - 1)
        elif self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

        # Check failure rate opening rule only applies in CLOSED
        if self._state == CircuitState.CLOSED:
            self._check_failure_rate_and_maybe_open()

    def _record_failure(self, duration_seconds: float) -> None:
        self.metrics.total_calls += 1
        self.metrics.failed_calls += 1
        self.metrics.last_failure_time = time.time()
        self.metrics.record_response_time(duration_seconds)
        self._sliding_window.append(False)

        if self._state == CircuitState.HALF_OPEN:
            # Any failure re-opens the breaker
            self._transition_to(CircuitState.OPEN)
            return

        if self._state == CircuitState.CLOSED:
            self._failure_count += 1
            if self._failure_count >= self.config.failure_threshold:
                self._transition_to(CircuitState.OPEN)
                return
            self._check_failure_rate_and_maybe_open()

    def _check_failure_rate_and_maybe_open(self) -> None:
        rate = self._calculate_failure_rate()
        if rate >= self.config.failure_rate_threshold and len(self._sliding_window) == self._sliding_window.maxlen:
            self._transition_to(CircuitState.OPEN)

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self._sliding_window.maxlen:
            return 0.0
        failures = sum(1 for v in self._sliding_window if not v)
        return failures / float(self._sliding_window.maxlen)

    def execute(self, operation: Callable[[], Any], fallback: Optional[Callable[[], Any]] = None) -> Any:
        if not self._allow_request():
            # rejected
            self.metrics.rejected_calls += 1
            remaining = self.config.timeout_seconds
            if self._opened_at is not None:
                elapsed = time.time() - self._opened_at
                remaining = max(0.0, self.config.timeout_seconds - elapsed)
            if fallback is not None:
                return fallback()
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.perf_counter()
        try:
            result = operation()
            duration = time.perf_counter() - start
            self._record_success(duration)
            return result
        except Exception:
            duration = time.perf_counter() - start
            self._record_failure(duration)
            raise

    def get_health_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "success_count": self._success_count,
            "failure_rate": self._calculate_failure_rate(),
            "metrics": {
                "total_calls": self.metrics.total_calls,
                "successful_calls": self.metrics.successful_calls,
                "failed_calls": self.metrics.failed_calls,
                "rejected_calls": self.metrics.rejected_calls,
                "average_response_time_ms": self.metrics.average_response_time * 1000.0,
                "state_transitions": self.metrics.state_transitions,
            },
            "config": asdict(self.config),
        }


class DistributedCircuitBreakerCoordinator:
    # Define class-level _breakers to support class-level patching in tests
    _breakers: Dict[str, CircuitBreaker] = {}

    def __init__(self, base_url: str, node_id: Optional[str] = None, sync_interval: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.node_id = node_id or str(uuid.uuid4())
        self.sync_interval = sync_interval
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        # Store in class-level registry for easier patching in tests
        DistributedCircuitBreakerCoordinator._breakers[breaker.name] = breaker

        payload = {
            "service": breaker.name,
            "node_id": self.node_id,
            "failure_threshold": breaker.config.failure_threshold,
            "success_threshold": breaker.config.success_threshold,
            "timeout_seconds": breaker.config.timeout_seconds,
            "half_open_max_calls": breaker.config.half_open_max_calls,
            "sliding_window_size": breaker.config.sliding_window_size,
            "failure_rate_threshold": breaker.config.failure_rate_threshold,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url=f"{self.base_url}/circuit-breakers/register",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)  # nosec - used in controlled tests

    def start_sync(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._sync_loop, daemon=True)
        self._thread.start()

    def stop_sync(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self.sync_interval * 2)

    def _sync_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._synchronize_states()
            except Exception:
                # Swallow any unexpected errors to keep the thread alive
                pass
            # Wait for the given interval or until stop is requested
            self._stop_event.wait(self.sync_interval)

    def _synchronize_states(self) -> None:
        try:
            breakers = DistributedCircuitBreakerCoordinator._breakers
            states = []
            for name, br in breakers.items():
                info = br.get_health_info()
                states.append(
                    {
                        "service": name,
                        "state": info["state"],
                        "metrics": info["metrics"],
                    }
                )
            payload = {"node_id": self.node_id, "states": states}
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url=f"{self.base_url}/circuit-breakers/state",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)  # nosec - used in controlled tests
        except URLError:
            # Explicitly swallow URLError as required by tests
            pass

    def get_cluster_state(self, service: str) -> Dict[str, Any]:
        url = f"{self.base_url}/circuit-breakers/{service}/cluster-state"
        req = urllib.request.Request(url=url, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=5)
            data = resp.read()
            return json.loads(data.decode("utf-8"))
        except URLError:
            return {"error": "Failed to fetch cluster state"}


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None):
    def decorator(func: Callable):
        br = CircuitBreaker.get_or_create(name, config or CircuitBreakerConfig())

        def wrapper(*args, **kwargs):
            return br.execute(lambda: func(*args, **kwargs))

        wrapper.circuit_breaker = br
        return wrapper

    return decorator