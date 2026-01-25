from enum import Enum
import time
import threading
import json
import os
from collections import deque
from functools import wraps
from typing import Callable, Any, Optional, Dict
from urllib import request, error


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerConfig:
    def __init__(
        self,
        failure_threshold: int = 5,
        success_threshold: int = 3,
        timeout_seconds: float = 30.0,
        half_open_max_calls: int = 3,
        sliding_window_size: int = 10,
        failure_rate_threshold: float = 0.5,
    ):
        self.failure_threshold = failure_threshold
        self.success_threshold = success_threshold
        self.timeout_seconds = float(timeout_seconds)
        self.half_open_max_calls = half_open_max_calls
        self.sliding_window_size = sliding_window_size
        self.failure_rate_threshold = float(failure_rate_threshold)


class CircuitBreakerMetrics:
    def __init__(self):
        self.total_calls: int = 0
        self.successful_calls: int = 0
        self.failed_calls: int = 0
        self.rejected_calls: int = 0
        self.state_transitions: int = 0
        self.last_failure_time: Optional[float] = None
        self.last_success_time: Optional[float] = None
        self.average_response_time: float = 0.0
        self._response_times: deque = deque(maxlen=100)

    def record_response_time(self, duration: float) -> None:
        self._response_times.append(duration)
        if self._response_times:
            self.average_response_time = sum(self._response_times) / len(
                self._response_times
            )
        else:
            self.average_response_time = 0.0


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = remaining_time
        msg = (
            f"Circuit breaker '{name}' is open. "
            f"Retry after {remaining_time:.2f} seconds."
        )
        super().__init__(msg)


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0
        self._half_open_calls: int = 0
        self._opened_at: Optional[float] = None
        self._state_lock: threading.RLock = threading.RLock()
        self._sliding_window: deque = deque(
            maxlen=self.config.sliding_window_size
        )  # True = failure, False = success
        self.metrics: CircuitBreakerMetrics = CircuitBreakerMetrics()

    @classmethod
    def get_or_create(
        cls, name: str, config: Optional[CircuitBreakerConfig] = None
    ) -> "CircuitBreaker":
        if name not in cls._registry:
            cls._registry[name] = CircuitBreaker(name=name, config=config)
        return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        with self._state_lock:
            if self._state == CircuitState.OPEN and self._should_attempt_reset():
                self._transition_to(CircuitState.HALF_OPEN)
            return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        return (time.time() - self._opened_at) >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState) -> None:
        with self._state_lock:
            if self._state == new_state:
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
        state = self.state
        if state == CircuitState.CLOSED:
            return True
        if state == CircuitState.OPEN:
            return False
        if state == CircuitState.HALF_OPEN:
            if self._half_open_calls < self.config.half_open_max_calls:
                self._half_open_calls += 1
                return True
            return False
        return False

    def execute(self, operation: Callable[[], Any], fallback: Optional[Callable[[], Any]] = None) -> Any:
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            if fallback is not None:
                return fallback()
            remaining = 0.0
            if self._opened_at is not None:
                elapsed = time.time() - self._opened_at
                remaining = max(self.config.timeout_seconds - elapsed, 0.0)
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        self.metrics.total_calls += 1
        try:
            result = operation()
        except Exception:
            duration = time.time() - start
            self._record_failure(duration)
            raise
        else:
            duration = time.time() - start
            self._record_success(duration)
            return result

    def _record_success(self, duration: float) -> None:
        self.metrics.successful_calls += 1
        self.metrics.last_success_time = time.time()
        self.metrics.record_response_time(duration)

        if self._state == CircuitState.CLOSED:
            if self._failure_count > 0:
                self._failure_count -= 1
            self._sliding_window.append(False)
        elif self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            self._sliding_window.append(False)
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration: float) -> None:
        self.metrics.failed_calls += 1
        self.metrics.last_failure_time = time.time()
        self.metrics.record_response_time(duration)
        self._sliding_window.append(True)

        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        if self._state == CircuitState.CLOSED:
            self._failure_count += 1
            if self._failure_count >= self.config.failure_threshold:
                self._transition_to(CircuitState.OPEN)
                return
            failure_rate = self._calculate_failure_rate()
            if failure_rate >= self.config.failure_rate_threshold:
                self._transition_to(CircuitState.OPEN)

    def _calculate_failure_rate(self) -> float:
        window_size = self.config.sliding_window_size
        if len(self._sliding_window) < window_size or window_size == 0:
            return 0.0
        failures = sum(1 for v in self._sliding_window if v)
        return failures / float(window_size)

    def get_health_info(self) -> Dict[str, Any]:
        failure_rate = self._calculate_failure_rate()
        metrics = {
            "total_calls": self.metrics.total_calls,
            "successful_calls": self.metrics.successful_calls,
            "failed_calls": self.metrics.failed_calls,
            "rejected_calls": self.metrics.rejected_calls,
            "state_transitions": self.metrics.state_transitions,
            "average_response_time_ms": self.metrics.average_response_time * 1000.0,
        }
        config = {
            "failure_threshold": self.config.failure_threshold,
            "success_threshold": self.config.success_threshold,
            "timeout_seconds": self.config.timeout_seconds,
            "half_open_max_calls": self.config.half_open_max_calls,
            "sliding_window_size": self.config.sliding_window_size,
            "failure_rate_threshold": self.config.failure_rate_threshold,
        }
        return {
            "name": self.name,
            "state": self._state.value,
            "failure_count": self._failure_count,
            "success_count": self._success_count,
            "failure_rate": float(failure_rate),
            "metrics": metrics,
            "config": config,
        }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, coordinator_url: str, sync_interval: float = 5.0):
        self.coordinator_url = coordinator_url.rstrip("/")
        self.sync_interval = float(sync_interval)
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running: bool = False
        self._sync_thread: Optional[threading.Thread] = None
        self.node_id: str = f"python-{os.getpid()}"

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        self._send_registration(breaker)

    def _send_registration(self, breaker: CircuitBreaker) -> None:
        url = f"{self.coordinator_url}/circuit-breakers/register"
        payload = {
            "node_id": self.node_id,
            "breaker": breaker.get_health_info(),
        }
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            request.urlopen(req)
        except Exception:
            # Silently ignore network errors as tests expect no exception
            return

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True
        self._sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
        self._sync_thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._sync_thread is not None:
            self._sync_thread.join(timeout=self.sync_interval * 2)
            self._sync_thread = None

    def _sync_loop(self) -> None:
        while self._running:
            self._synchronize_states()
            time.sleep(self.sync_interval)

    def _synchronize_states(self) -> None:
        url = f"{self.coordinator_url}/circuit-breakers/state"
        for breaker in list(self._breakers.values()):
            payload = {
                "node_id": self.node_id,
                "breaker": breaker.get_health_info(),
            }
            data = json.dumps(payload).encode("utf-8")
            req = request.Request(url, data=data, method="POST")
            req.add_header("Content-Type", "application/json")
            try:
                request.urlopen(req)
            except Exception:
                # Ignore network errors
                continue

    def get_cluster_state(self, service_name: str) -> Dict[str, Any]:
        url = f"{self.coordinator_url}/circuit-breakers/{service_name}/aggregate"
        req = request.Request(url, method="GET")
        try:
            resp = request.urlopen(req)
            raw = resp.read()
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {"error": "Failed to fetch cluster state"}


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None):
    def decorator(func: Callable):
        breaker = CircuitBreaker.get_or_create(name, config)

        @wraps(func)
        def wrapper(*args, **kwargs):
            return breaker.execute(lambda: func(*args, **kwargs))

        # expose breaker for tests/introspection
        wrapper.circuit_breaker = breaker
        return wrapper

    return decorator