from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from enum import Enum


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerOpenError(RuntimeError):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = float(remaining_time)
        super().__init__(f"Circuit breaker '{name}' is open. Retry after {self.remaining_time:.2f}s")


@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    success_threshold: int = 3
    timeout_seconds: float = 30.0
    half_open_max_calls: int = 3
    sliding_window_size: int = 10
    failure_rate_threshold: float = 0.5


class CircuitBreakerMetrics:
    def __init__(self):
        self.total_calls = 0
        self.successful_calls = 0
        self.failed_calls = 0
        self.rejected_calls = 0
        self.state_transitions = 0
        self.average_response_time = 0.0
        self._response_times = deque(maxlen=100)

    def record_response_time(self, duration: float) -> None:
        self._response_times.append(float(duration))
        if self._response_times:
            self.average_response_time = sum(self._response_times) / len(self._response_times)
        else:
            self.average_response_time = 0.0


class CircuitBreaker:
    _registry: dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: CircuitBreakerConfig | None = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._half_open_calls = 0
        self._opened_at: float | None = None
        self.metrics = CircuitBreakerMetrics()
        self._sliding_window = deque(maxlen=self.config.sliding_window_size)

    @classmethod
    def get_or_create(cls, name: str, config: CircuitBreakerConfig | None = None) -> "CircuitBreaker":
        if name in cls._registry:
            return cls._registry[name]
        b = cls(name=name, config=config or CircuitBreakerConfig())
        cls._registry[name] = b
        return b

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
        if self._state != new_state:
            self.metrics.state_transitions += 1

        self._state = new_state
        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
            self._half_open_calls = 0
            self._success_count = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0
            self._opened_at = None
        elif new_state == CircuitState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
            self._opened_at = None
            self._sliding_window.clear()

    def _allow_request(self) -> bool:
        st = self.state
        if st == CircuitState.CLOSED:
            return True
        if st == CircuitState.OPEN:
            return False
        if st == CircuitState.HALF_OPEN:
            if self._half_open_calls >= self.config.half_open_max_calls:
                return False
            self._half_open_calls += 1
            return True
        return False

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self.config.sliding_window_size:
            return 0.0
        failures = sum(1 for ok in self._sliding_window if not ok)
        return failures / len(self._sliding_window) if self._sliding_window else 0.0

    def _record_success(self, duration: float) -> None:
        self.metrics.successful_calls += 1
        self.metrics.record_response_time(duration)
        self._sliding_window.append(True)

        if self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)
            return

        if self._failure_count > 0:
            self._failure_count -= 1

    def _record_failure(self, duration: float) -> None:
        self.metrics.failed_calls += 1
        self.metrics.record_response_time(duration)
        self._sliding_window.append(False)

        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        self._failure_count += 1
        if self._failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)
            return

        if self._calculate_failure_rate() > self.config.failure_rate_threshold:
            self._transition_to(CircuitState.OPEN)

    def execute(self, func, fallback=None):
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            now = time.time()
            opened_at = self._opened_at if self._opened_at is not None else now

            # Clamp remaining time to [0, timeout_seconds] even if clock drift makes elapsed negative.
            elapsed = now - opened_at
            remaining = self.config.timeout_seconds - elapsed
            if remaining < 0:
                remaining = 0.0
            if remaining > self.config.timeout_seconds:
                remaining = float(self.config.timeout_seconds)

            if fallback is not None:
                return fallback()
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        self.metrics.total_calls += 1
        try:
            result = func()
        except Exception:
            end = time.time()
            self._record_failure(end - start)
            _ = time.time()
            raise
        else:
            end = time.time()
            self._record_success(end - start)
            _ = time.time()
            return result

    def get_health_info(self) -> dict:
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
    def __init__(self, coordinator_url: str, sync_interval: float = 1.0):
        self.coordinator_url = coordinator_url.rstrip("/")
        self.sync_interval = float(sync_interval)
        self.node_id = os.environ.get("NODE_ID", "node-1")
        self._breakers: dict[str, CircuitBreaker] = {}
        self._running = False
        self._sync_thread: threading.Thread | None = None

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        self._send_registration(breaker)

    def _send_registration(self, breaker: CircuitBreaker) -> None:
        url = f"{self.coordinator_url}/circuit-breakers/register"
        payload = {
            "service": breaker.name,
            "node_id": self.node_id,
            "failure_threshold": breaker.config.failure_threshold,
            "success_threshold": breaker.config.success_threshold,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except urllib.error.URLError:
            return

    def _synchronize_states(self) -> None:
        url = f"{self.coordinator_url}/circuit-breakers/state"
        for breaker in list(self._breakers.values()):
            payload = {
                "service": breaker.name,
                "node_id": self.node_id,
                "state": breaker.state.value,
                "failure_count": breaker._failure_count,
                "timestamp": int(time.time() * 1000),
                "health_info": breaker.get_health_info(),
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={"Content-type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=5)
            except urllib.error.URLError:
                continue

    def _sync_loop(self) -> None:
        while self._running:
            try:
                self._synchronize_states()
            except Exception:
                pass
            time.sleep(self.sync_interval)

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True
        self._sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
        self._sync_thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._sync_thread is not None:
            self._sync_thread.join(timeout=2)

    def get_cluster_state(self, service: str) -> dict:
        url = f"{self.coordinator_url}/circuit-breakers/{service}/aggregate"
        req = urllib.request.Request(url, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=5)
            return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError:
            return {"error": "Failed to fetch cluster state"}