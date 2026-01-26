from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque, Dict, Optional
from urllib.error import URLError
import urllib.request
from collections import deque
import json
import threading


class CircuitState(str, Enum):
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
    average_response_time: float = 0.0  # seconds
    last_success_time: Optional[float] = None
    last_failure_time: Optional[float] = None

    _rt_count: int = field(default=0, init=False, repr=False)

    def record_response_time(self, response_time_seconds: float) -> None:
        self._rt_count += 1
        # Running average
        self.average_response_time += (response_time_seconds - self.average_response_time) / self._rt_count


class CircuitBreakerOpenError(RuntimeError):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = remaining_time
        super().__init__(f"Circuit breaker '{name}' is open. Retry after {remaining_time:.2f}s")


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
        self._sliding_window: Deque[bool] = deque(maxlen=self.config.sliding_window_size)

        self.metrics = CircuitBreakerMetrics()

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name in cls._registry:
            return cls._registry[name]
        br = cls(name=name, config=config or CircuitBreakerConfig())
        cls._registry[name] = br
        return br

    @property
    def state(self) -> CircuitState:
        # Lazily attempt reset when OPEN and timeout elapsed
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
            # keep counts/windows as-is
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0
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
        # HALF_OPEN
        if self._half_open_calls < self.config.half_open_max_calls:
            self._half_open_calls += 1
            return True
        return False

    def _calculate_failure_rate(self) -> float:
        if len(self._sliding_window) < self.config.sliding_window_size:
            return 0.0
        failures = sum(1 for ok in self._sliding_window if not ok)
        return failures / float(self.config.sliding_window_size)

    def _record_success(self, response_time_seconds: float) -> None:
        self.metrics.successful_calls += 1
        self.metrics.last_success_time = time.time()
        self.metrics.record_response_time(response_time_seconds)

        self._sliding_window.append(True)

        if self._failure_count > 0:
            self._failure_count -= 1

        if self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, response_time_seconds: float) -> None:
        self.metrics.failed_calls += 1
        self.metrics.last_failure_time = time.time()
        self.metrics.record_response_time(response_time_seconds)

        self._sliding_window.append(False)
        self._failure_count += 1

        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        if self._state == CircuitState.CLOSED:
            if self._failure_count >= self.config.failure_threshold:
                self._transition_to(CircuitState.OPEN)
                return

            rate = self._calculate_failure_rate()
            if rate >= self.config.failure_rate_threshold and len(self._sliding_window) >= self.config.sliding_window_size:
                self._transition_to(CircuitState.OPEN)

    def execute(self, func: Callable[[], Any], fallback: Optional[Callable[[], Any]] = None) -> Any:
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            if fallback is not None:
                return fallback()
            now = time.time()
            opened_at = self._opened_at or now
            remaining = max(0.0, self.config.timeout_seconds - (now - opened_at))
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        try:
            result = func()
        except Exception:
            end = time.time()
            self._record_failure(end - start)
            raise
        else:
            end = time.time()
            self.metrics.total_calls += 1
            self._record_success(end - start)
            return result

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
                "last_success_time": self.metrics.last_success_time,
                "last_failure_time": self.metrics.last_failure_time,
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
    def __init__(self, coordinator_url: str, sync_interval: float = 5.0, node_id: Optional[str] = None):
        self.coordinator_url = coordinator_url.rstrip("/")
        self.sync_interval = float(sync_interval)
        self.node_id = node_id or os.getenv("NODE_ID", "unknown-node")
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running: bool = False
        self._sync_thread: Optional[threading.Thread] = None

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
            "timeout_seconds": breaker.config.timeout_seconds,
            "half_open_max_calls": breaker.config.half_open_max_calls,
            "sliding_window_size": breaker.config.sliding_window_size,
            "failure_rate_threshold": breaker.config.failure_rate_threshold,
        }
        data = json.dumps(payload).encode("utf-8")
        # IMPORTANT: include explicit headers dict so tests can access req.headers["Content-Type"]
        req = urllib.request.Request(
            url=url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except URLError:
            return

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True
        t = threading.Thread(target=self._sync_loop, daemon=True)
        self._sync_thread = t
        t.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._sync_thread is not None:
            self._sync_thread.join(timeout=2)

    def _sync_loop(self) -> None:
        while self._running:
            try:
                self._synchronize_states()
            except Exception:
                pass
            time.sleep(self.sync_interval)

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
                url=url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(req, timeout=5)
            except URLError:
                continue

    def get_cluster_state(self, service: str) -> Dict[str, Any]:
        url = f"{self.coordinator_url}/circuit-breakers/{service}/aggregate"
        req = urllib.request.Request(url=url, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=5)
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
        except URLError:
            return {"error": "Failed to fetch cluster state"}