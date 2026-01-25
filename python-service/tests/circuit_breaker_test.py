import enum
import json
import threading
import time
from collections import deque
from dataclasses import dataclass, asdict
from typing import Any, Callable, Deque, Dict, Optional

from urllib import request, error


class CircuitState(enum.Enum):
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


class CircuitBreakerMetrics:
    def __init__(self) -> None:
        self.total_calls: int = 0
        self.successful_calls: int = 0
        self.failed_calls: int = 0
        self.rejected_calls: int = 0
        self.state_transitions: int = 0
        self.last_failure_time: Optional[float] = None
        self.last_success_time: Optional[float] = None
        self.average_response_time: float = 0.0
        self._response_times: Deque[float] = deque(maxlen=100)

    def record_response_time(self, duration: float) -> None:
        self._response_times.append(duration)
        if self._response_times:
            self.average_response_time = sum(self._response_times) / len(self._response_times)
        else:
            self.average_response_time = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_calls": self.total_calls,
            "successful_calls": self.successful_calls,
            "failed_calls": self.failed_calls,
            "rejected_calls": self.rejected_calls,
            "state_transitions": self.state_transitions,
            "last_failure_time": self.last_failure_time,
            "last_success_time": self.last_success_time,
            "average_response_time": self.average_response_time,
        }


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float) -> None:
        self.name = name
        self.remaining_time = remaining_time
        msg = (
            f"Circuit breaker '{name}' is open. "
            f"Retry after {remaining_time:.2f} seconds."
        )
        super().__init__(msg)


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None) -> None:
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0
        self._half_open_calls: int = 0
        self._opened_at: Optional[float] = None
        self._sliding_window: Deque[bool] = deque(maxlen=self.config.sliding_window_size)
        self.metrics = CircuitBreakerMetrics()

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name not in cls._registry:
            cls._registry[name] = CircuitBreaker(name=name, config=config or CircuitBreakerConfig())
        return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN and self._should_attempt_reset():
            self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        return (time.time() - self._opened_at) >= self.config.timeout_seconds

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
        current_state = self.state
        if current_state == CircuitState.CLOSED:
            return True
        if current_state == CircuitState.OPEN:
            return False
        if current_state == CircuitState.HALF_OPEN:
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
                remaining = max(0.0, self.config.timeout_seconds - elapsed)
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        self.metrics.total_calls += 1
        try:
            result = operation()
            duration = time.time() - start
            self._record_success(duration)
            return result
        except Exception:
            duration = time.time() - start
            self._record_failure(duration)
            raise

    def _record_success(self, duration: float) -> None:
        self.metrics.successful_calls += 1
        self.metrics.last_success_time = time.time()
        self.metrics.record_response_time(duration)
        self._sliding_window.append(True)

        if self._state == CircuitState.CLOSED:
            if self._failure_count > 0:
                self._failure_count -= 1
        elif self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self.config.sliding_window_size:
            return 0.0
        failures = sum(1 for success in self._sliding_window if not success)
        return failures / len(self._sliding_window) if self._sliding_window else 0.0

    def _record_failure(self, duration: float) -> None:
        self.metrics.failed_calls += 1
        self.metrics.last_failure_time = time.time()
        self.metrics.record_response_time(duration)
        self._sliding_window.append(False)

        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        if self._state == CircuitState.CLOSED:
            self._failure_count += 1
            failure_rate = self._calculate_failure_rate()
            if (
                self._failure_count >= self.config.failure_threshold
                or failure_rate >= self.config.failure_rate_threshold
            ):
                self._transition_to(CircuitState.OPEN)

    def get_health_info(self) -> Dict[str, Any]:
        failure_rate = self._calculate_failure_rate()
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "success_count": self._success_count,
            "failure_rate": float(failure_rate),
            "metrics": self.metrics.to_dict(),
            "config": asdict(self.config),
        }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, coordinator_url: str, sync_interval: float = 5.0) -> None:
        self.coordinator_url = coordinator_url.rstrip("/")
        self.sync_interval = sync_interval
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running: bool = False
        self._sync_thread: Optional[threading.Thread] = None
        self.node_id: str = f"node-{int(time.time() * 1000)}"

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
            # Intentionally ignore network errors in tests
            pass

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

    def _sync_loop(self) -> None:
        while self._running:
            self._synchronize_states()
            time.sleep(self.sync_interval)

    def _synchronize_states(self) -> None:
        if not self._breakers:
            return
        url = f"{self.coordinator_url}/circuit-breakers/state"
        state_payload = {
            "node_id": self.node_id,
            "breakers": {name: br.get_health_info() for name, br in self._breakers.items()},
        }
        data = json.dumps(state_payload).encode("utf-8")
        req = request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            request.urlopen(req)
        except Exception:
            # Ignore sync errors
            pass

    def get_cluster_state(self, breaker_name: str) -> Dict[str, Any]:
        url = f"{self.coordinator_url}/circuit-breakers/{breaker_name}/aggregate"
        req = request.Request(url, method="GET")
        try:
            resp = request.urlopen(req)
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
        except Exception:
            return {"error": "Failed to fetch cluster state"}


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None) -> Callable:
    def decorator(func: Callable) -> Callable:
        breaker = CircuitBreaker.get_or_create(name, config)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            def operation() -> Any:
                return func(*args, **kwargs)

            return breaker.execute(operation)

        wrapper.__wrapped__ = func  # type: ignore[attr-defined]
        wrapper.circuit_breaker = breaker  # type: ignore[attr-defined]
        return wrapper

    return decorator