"""
Distributed Circuit Breaker implementation for Python services.
Implements the circuit breaker pattern with state synchronization across nodes.
"""

import time
import threading
import enum
import json
import os
from dataclasses import dataclass, field
from typing import TypeVar, Callable, Optional, Dict, Any
from collections import deque
import urllib.request
import urllib.error


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


@dataclass
class CircuitBreakerMetrics:
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    rejected_calls: int = 0
    state_transitions: int = 0
    last_failure_time: Optional[float] = None
    last_success_time: Optional[float] = None
    average_response_time: float = 0.0
    _response_times: deque = field(default_factory=lambda: deque(maxlen=100))

    def record_response_time(self, duration: float) -> None:
        self._response_times.append(duration)
        if self._response_times:
            self.average_response_time = sum(self._response_times) / len(self._response_times)


T = TypeVar('T')


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = remaining_time
        super().__init__(f"Circuit breaker '{name}' is open. Retry after {remaining_time:.2f}s")


class CircuitBreaker:
    _registry: Dict[str, 'CircuitBreaker'] = {}
    _lock = threading.Lock()

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._half_open_calls = 0
        self._opened_at: Optional[float] = None
        self._state_lock = threading.RLock()
        self._sliding_window: deque = deque(maxlen=self.config.sliding_window_size)
        self.metrics = CircuitBreakerMetrics()

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> 'CircuitBreaker':
        with cls._lock:
            if name not in cls._registry:
                cls._registry[name] = CircuitBreaker(name, config)
            return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        with self._state_lock:
            if self._state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    self._transition_to(CircuitState.HALF_OPEN)
            return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        return time.time() - self._opened_at >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState) -> None:
        old_state = self._state
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

    def execute(self, operation: Callable[[], T], fallback: Optional[Callable[[], T]] = None) -> T:
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            if fallback:
                return fallback()
            remaining = self.config.timeout_seconds - (time.time() - (self._opened_at or 0))
            raise CircuitBreakerOpenError(self.name, max(0, remaining))

        start_time = time.time()
        self.metrics.total_calls += 1

        try:
            result = operation()
            duration = time.time() - start_time
            self._record_success(duration)
            return result
        except Exception as e:
            duration = time.time() - start_time
            self._record_failure(duration)
            raise

    def _allow_request(self) -> bool:
        with self._state_lock:
            current_state = self.state

            if current_state == CircuitState.CLOSED:
                return True
            elif current_state == CircuitState.OPEN:
                return False
            elif current_state == CircuitState.HALF_OPEN:
                if self._half_open_calls < self.config.half_open_max_calls:
                    self._half_open_calls += 1
                    return True
                return False
            return False

    def _record_success(self, duration: float) -> None:
        with self._state_lock:
            self.metrics.successful_calls += 1
            self.metrics.last_success_time = time.time()
            self.metrics.record_response_time(duration)
            self._sliding_window.append(True)

            if self._state == CircuitState.HALF_OPEN:
                self._success_count += 1
                if self._success_count >= self.config.success_threshold:
                    self._transition_to(CircuitState.CLOSED)
            elif self._state == CircuitState.CLOSED:
                self._failure_count = max(0, self._failure_count - 1)

    def _record_failure(self, duration: float) -> None:
        with self._state_lock:
            self.metrics.failed_calls += 1
            self.metrics.last_failure_time = time.time()
            self.metrics.record_response_time(duration)
            self._sliding_window.append(False)

            if self._state == CircuitState.HALF_OPEN:
                self._transition_to(CircuitState.OPEN)
            elif self._state == CircuitState.CLOSED:
                self._failure_count += 1
                
                failure_rate = self._calculate_failure_rate()
                if (self._failure_count >= self.config.failure_threshold or 
                    failure_rate >= self.config.failure_rate_threshold):
                    self._transition_to(CircuitState.OPEN)

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self.config.sliding_window_size:
            return 0.0
        failures = sum(1 for success in self._sliding_window if not success)
        return failures / len(self._sliding_window)

    def get_health_info(self) -> Dict[str, Any]:
        with self._state_lock:
            return {
                "name": self.name,
                "state": self._state.value,
                "failure_count": self._failure_count,
                "success_count": self._success_count,
                "failure_rate": self._calculate_failure_rate(),
                "metrics": {
                    "total_calls": self.metrics.total_calls,
                    "successful_calls": self.metrics.successful_calls,
                    "failed_calls": self.metrics.failed_calls,
                    "rejected_calls": self.metrics.rejected_calls,
                    "average_response_time_ms": self.metrics.average_response_time * 1000,
                    "state_transitions": self.metrics.state_transitions,
                },
                "config": {
                    "failure_threshold": self.config.failure_threshold,
                    "success_threshold": self.config.success_threshold,
                    "timeout_seconds": self.config.timeout_seconds,
                }
            }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, coordinator_url: str, sync_interval: float = 5.0):
        self.coordinator_url = coordinator_url
        self.sync_interval = sync_interval
        self.node_id = os.environ.get("NODE_ID", f"python-{os.getpid()}")
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running = False
        self._sync_thread: Optional[threading.Thread] = None

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        self._send_registration(breaker)

    def _send_registration(self, breaker: CircuitBreaker) -> None:
        try:
            data = json.dumps({
                "service": breaker.name,
                "node_id": self.node_id,
                "failure_threshold": breaker.config.failure_threshold,
                "success_threshold": breaker.config.success_threshold,
            }).encode('utf-8')

            req = urllib.request.Request(
                f"{self.coordinator_url}/circuit-breakers/register",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            urllib.request.urlopen(req, timeout=5)
        except urllib.error.URLError:
            pass

    def start_sync(self) -> None:
        self._running = True
        self._sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
        self._sync_thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._sync_thread:
            self._sync_thread.join(timeout=2)

    def _sync_loop(self) -> None:
        while self._running:
            try:
                self._synchronize_states()
            except Exception:
                pass
            time.sleep(self.sync_interval)

    def _synchronize_states(self) -> None:
        for name, breaker in self._breakers.items():
            try:
                data = json.dumps({
                    "service": name,
                    "node_id": self.node_id,
                    "state": breaker.state.value,
                    "failure_count": breaker._failure_count,
                    "timestamp": int(time.time() * 1000),
                    "health_info": breaker.get_health_info(),
                }).encode('utf-8')

                req = urllib.request.Request(
                    f"{self.coordinator_url}/circuit-breakers/state",
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                urllib.request.urlopen(req, timeout=5)
            except urllib.error.URLError:
                pass

    def get_cluster_state(self, service_name: str) -> Dict[str, Any]:
        try:
            req = urllib.request.Request(
                f"{self.coordinator_url}/circuit-breakers/{service_name}/aggregate",
                method="GET"
            )
            response = urllib.request.urlopen(req, timeout=5)
            return json.loads(response.read().decode('utf-8'))
        except urllib.error.URLError:
            return {"error": "Failed to fetch cluster state"}


def circuit_breaker(name: str, config: Optional[CircuitBreakerConfig] = None):
    breaker = CircuitBreaker.get_or_create(name, config)

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        def wrapper(*args, **kwargs) -> T:
            return breaker.execute(lambda: func(*args, **kwargs))
        wrapper.__wrapped__ = func
        wrapper.circuit_breaker = breaker
        return wrapper
    return decorator
