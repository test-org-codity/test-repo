from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any, Callable, Dict, List, Optional
import json
import threading
import time
import uuid
import urllib.request
import urllib.parse
import urllib.error


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


class CircuitBreakerMetrics:
    def __init__(self) -> None:
        self.total_calls: int = 0
        self.successful_calls: int = 0
        self.failed_calls: int = 0
        self.rejected_calls: int = 0
        self.state_transitions: int = 0
        self._response_time_samples: int = 0
        self._response_time_total: float = 0.0
        self.average_response_time: float = 0.0

    def record_response_time(self, duration_seconds: float) -> None:
        self._response_time_samples += 1
        self._response_time_total += duration_seconds
        self.average_response_time = (
            self._response_time_total / self._response_time_samples
            if self._response_time_samples > 0
            else 0.0
        )


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float) -> None:
        self.name = name
        self.remaining_time = max(0.0, remaining_time)
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"CircuitBreaker '{self.name}' is OPEN. Try again in {self.remaining_time:.3f}s"


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: CircuitBreakerConfig) -> None:
        self.name = name
        self.config = config
        self.metrics = CircuitBreakerMetrics()

        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_streak: int = 0
        self._opened_at: Optional[float] = None
        self._half_open_calls: int = 0
        self._outcomes: List[bool] = []  # True = failure, False = success

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name in cls._registry:
            return cls._registry[name]
        instance = CircuitBreaker(name, config or CircuitBreakerConfig())
        cls._registry[name] = instance
        return instance

    @property
    def state(self) -> CircuitState:
        # Auto transition from OPEN -> HALF_OPEN if timeout elapsed when the property is accessed
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
        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
            self._half_open_calls = 0
            self._success_streak = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_streak = 0
        elif new_state == CircuitState.CLOSED:
            self._failure_count = 0
            self._success_streak = 0
            self._opened_at = None

    def _allow_request(self) -> bool:
        # Use internal state directly to avoid triggering auto-transition
        if self._state == CircuitState.CLOSED:
            return True
        if self._state == CircuitState.OPEN:
            return False
        if self._state == CircuitState.HALF_OPEN:
            if self._half_open_calls < self.config.half_open_max_calls:
                self._half_open_calls += 1
                return True
            return False
        return False

    def execute(self, operation: Callable[..., Any], fallback: Optional[Callable[[], Any]] = None, *args, **kwargs) -> Any:
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            # Calculate remaining time if in OPEN
            remaining = 0.0
            if self._state == CircuitState.OPEN and self._opened_at is not None:
                elapsed = time.time() - self._opened_at
                remaining = self.config.timeout_seconds - elapsed
            if fallback is not None:
                return fallback()
            raise CircuitBreakerOpenError(self.name, max(0.0, remaining))

        start = time.time()
        try:
            result = operation(*args, **kwargs)
            duration = time.time() - start
            self.metrics.total_calls += 1
            self.metrics.successful_calls += 1
            self.metrics.record_response_time(duration)
            self._record_success(duration)
            return result
        except Exception:
            duration = time.time() - start
            self.metrics.total_calls += 1
            self.metrics.failed_calls += 1
            self.metrics.record_response_time(duration)
            self._record_failure(duration)
            raise

    def _record_success(self, duration_seconds: float) -> None:
        # Update sliding window
        self._append_outcome(False)
        if self._state == CircuitState.HALF_OPEN:
            self._success_streak += 1
            if self._success_streak >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration_seconds: float) -> None:
        self._append_outcome(True)
        if self._state == CircuitState.CLOSED:
            self._failure_count += 1
            # Open by failure count
            if self._failure_count >= self.config.failure_threshold:
                self._transition_to(CircuitState.OPEN)
                return
            # Open by failure rate if window full
            rate = self._calculate_failure_rate()
            if len(self._outcomes) >= self.config.sliding_window_size and rate >= self.config.failure_rate_threshold:
                self._transition_to(CircuitState.OPEN)
                return
        elif self._state == CircuitState.HALF_OPEN:
            # Any failure in HALF_OPEN re-opens the circuit
            self._transition_to(CircuitState.OPEN)

    def _append_outcome(self, failure: bool) -> None:
        self._outcomes.append(bool(failure))
        if len(self._outcomes) > self.config.sliding_window_size:
            self._outcomes.pop(0)

    def _calculate_failure_rate(self) -> float:
        if len(self._outcomes) < self.config.sliding_window_size or self.config.sliding_window_size <= 0:
            return 0.0
        failures = sum(1 for o in self._outcomes if o)
        return failures / float(self.config.sliding_window_size)

    def get_health_info(self) -> Dict[str, Any]:
        avg_ms = self.metrics.average_response_time * 1000.0 if self.metrics.average_response_time is not None else 0.0
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "success_count": self.metrics.successful_calls,
            "failure_rate": self._calculate_failure_rate(),
            "metrics": {
                "total_calls": self.metrics.total_calls,
                "successful_calls": self.metrics.successful_calls,
                "failed_calls": self.metrics.failed_calls,
                "rejected_calls": self.metrics.rejected_calls,
                "state_transitions": self.metrics.state_transitions,
                "average_response_time_ms": avg_ms,
            },
            "config": asdict(self.config),
        }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, base_url: str, sync_interval: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.sync_interval = sync_interval
        self.node_id = str(uuid.uuid4())
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._stop_event = threading.Event()
        self._sync_thread: Optional[threading.Thread] = None

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        payload = {
            "service": breaker.name,
            "node_id": self.node_id,
            "failure_threshold": breaker.config.failure_threshold,
            "success_threshold": breaker.config.success_threshold,
        }
        data = json.dumps(payload).encode("utf-8")
        url = f"{self.base_url}/circuit-breakers/register"
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req)

    def _synchronize_states(self) -> None:
        for breaker in self._breakers.values():
            payload = {
                "service": breaker.name,
                "state": breaker.state.value,
                "failure_count": breaker._failure_count,
                "timestamp": int(time.time()),
                "health_info": breaker.get_health_info(),
            }
            data = json.dumps(payload).encode("utf-8")
            url = f"{self.base_url}/circuit-breakers/state"
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req)

    def start_sync(self) -> None:
        if self._sync_thread and self._sync_thread.is_alive():
            return

        self._stop_event.clear()

        def _runner():
            while not self._stop_event.is_set():
                try:
                    self._synchronize_states()
                except Exception:
                    # Swallow exceptions to keep sync alive during tests
                    pass
                time.sleep(self.sync_interval)

        self._sync_thread = threading.Thread(target=_runner, daemon=True)
        self._sync_thread.start()

    def stop_sync(self) -> None:
        self._stop_event.set()
        if self._sync_thread:
            self._sync_thread.join(timeout=self.sync_interval * 5)
            self._sync_thread = None

    def get_cluster_state(self, service: str) -> Dict[str, Any]:
        try:
            query = urllib.parse.urlencode({"service": service})
            url = f"{self.base_url}/circuit-breakers/cluster-state?{query}"
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req)
            data = resp.read()
            return json.loads(data.decode("utf-8"))
        except urllib.error.URLError:
            return {"error": "Failed to fetch cluster state"}


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    breaker = CircuitBreaker.get_or_create(name, config or CircuitBreakerConfig())

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        def wrapper(*args, **kwargs):
            return breaker.execute(lambda: func(*args, **kwargs))
        # expose breaker instance on wrapper
        setattr(wrapper, "circuit_breaker", breaker)
        return wrapper

    return decorator