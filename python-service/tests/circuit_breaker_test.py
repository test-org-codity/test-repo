from dataclasses import dataclass, asdict
from enum import Enum
from typing import Callable, Deque, Dict, Optional
from collections import deque
import json
import threading
import time
from urllib import request, parse
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


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = remaining_time
        super().__init__(f"Circuit '{name}' is OPEN; retry after {remaining_time:.2f}s")

    def __str__(self) -> str:
        return f"Circuit '{self.name}' is OPEN; retry after {self.remaining_time:.2f}s"


class CircuitBreakerMetrics:
    def __init__(self) -> None:
        self.total_calls: int = 0
        self.successful_calls: int = 0
        self.failed_calls: int = 0
        self.rejected_calls: int = 0
        self.state_transitions: int = 0

        self._response_time_sum: float = 0.0
        self._response_time_count: int = 0
        self.average_response_time: float = 0.0

    def record_response_time(self, seconds: float) -> None:
        self._response_time_sum += seconds
        self._response_time_count += 1
        if self._response_time_count > 0:
            self.average_response_time = self._response_time_sum / self._response_time_count


class CircuitBreaker:
    _registry: Dict[str, "CircuitBreaker"] = {}

    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None) -> None:
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self.metrics = CircuitBreakerMetrics()

        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0
        self._half_open_calls: int = 0
        self._opened_at: Optional[float] = None
        self._sliding_window: Deque[bool] = deque()

    @classmethod
    def get_or_create(cls, name: str, config: Optional[CircuitBreakerConfig] = None) -> "CircuitBreaker":
        if name in cls._registry:
            return cls._registry[name]
        inst = cls(name, config)
        cls._registry[name] = inst
        return inst

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN and self._should_attempt_reset():
            self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _allow_request(self) -> bool:
        # Directly check internal state to avoid unexpected time calls
        if self._state == CircuitState.CLOSED:
            return True
        if self._state == CircuitState.OPEN:
            # Re-check through property to possibly move to HALF_OPEN
            if self.state == CircuitState.OPEN:
                return False
        if self._state == CircuitState.HALF_OPEN:
            if self._half_open_calls < self.config.half_open_max_calls:
                self._half_open_calls += 1
                return True
            return False
        return False

    def execute(self, func: Callable, fallback: Optional[Callable] = None):
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            if fallback is not None:
                return fallback()
            # compute remaining time safely
            remaining = 0.0
            if self._opened_at is not None:
                elapsed = time.time() - self._opened_at
                remaining = max(0.0, self.config.timeout_seconds - elapsed)
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        try:
            result = func()
            duration = time.time() - start
            self.metrics.total_calls += 1
            self.metrics.successful_calls += 1
            self._record_success(duration)
            return result
        except Exception:
            duration = time.time() - start
            self.metrics.total_calls += 1
            self.metrics.failed_calls += 1
            self._record_failure(duration)
            raise

    def _record_success(self, duration: float) -> None:
        self.metrics.record_response_time(duration)
        self._append_to_window(True)

        if self._state == CircuitState.CLOSED:
            if self._failure_count > 0:
                self._failure_count -= 1
        elif self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration: float) -> None:
        self.metrics.record_response_time(duration)
        self._append_to_window(False)

        self._failure_count += 1
        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        if self._failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)
            return

        rate = self._calculate_failure_rate()
        if self._is_window_full() and rate >= self.config.failure_rate_threshold:
            self._transition_to(CircuitState.OPEN)

    def _append_to_window(self, success: bool) -> None:
        self._sliding_window.append(success)
        # keep only last N entries up to window size
        while len(self._sliding_window) > self.config.sliding_window_size:
            self._sliding_window.popleft()

    def _is_window_full(self) -> bool:
        return len(self._sliding_window) >= self.config.sliding_window_size and self.config.sliding_window_size > 0

    def _calculate_failure_rate(self) -> float:
        if not self._is_window_full():
            return 0.0
        total = len(self._sliding_window)
        failures = sum(1 for s in self._sliding_window if not s)
        return failures / total if total else 0.0

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        return (time.time() - self._opened_at) >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState) -> None:
        if self._state == new_state:
            return
        self._state = new_state
        self.metrics.state_transitions += 1

        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
            self._success_count = 0
            self._half_open_calls = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._success_count = 0
            self._half_open_calls = 0
        elif new_state == CircuitState.CLOSED:
            self._opened_at = None
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
            self._sliding_window.clear()

    def get_health_info(self) -> Dict:
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
            "config": asdict(self.config),
            "failure_count": self._failure_count,
        }


class DistributedCircuitBreakerCoordinator:
    def __init__(self, base_url: str, sync_interval: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.sync_interval = sync_interval
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._running: bool = False
        self._thread: Optional[threading.Thread] = None

    def register_breaker(self, breaker: CircuitBreaker) -> None:
        self._breakers[breaker.name] = breaker
        url = f"{self.base_url}/circuit-breakers/register"
        payload = json.dumps({"service": breaker.name}).encode("utf-8")
        req = request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        request.urlopen(req)  # no timeout specified in test

    def _synchronize_states(self) -> None:
        for breaker in list(self._breakers.values()):
            url = f"{self.base_url}/circuit-breakers/state"
            payload = {
                "service": breaker.name,
                "state": breaker.state.value,
                "failure_count": breaker._failure_count,
                "timestamp": int(time.time() * 1000),
                "health_info": breaker.get_health_info(),
            }
            data = json.dumps(payload).encode("utf-8")
            req = request.Request(url, data=data, headers={"Content-Type": "application/json"})
            try:
                request.urlopen(req, timeout=5)
            except Exception:
                # Swallow exceptions during sync
                pass

    def get_cluster_state(self, service: str) -> Dict:
        try:
            url = f"{self.base_url}/cluster/state?{parse.urlencode({'service': service})}"
            resp = request.urlopen(url)
            content = resp.read().decode("utf-8")
            return json.loads(content)
        except URLError as e:
            return {"error": str(e)}

    def start_sync(self) -> None:
        if self._running:
            return
        self._running = True

        def run():
            while self._running:
                self._synchronize_states()
                if not self._running:
                    break
                time.sleep(self.sync_interval)

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def stop_sync(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None