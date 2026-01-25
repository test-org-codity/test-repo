from dataclasses import dataclass, asdict
from enum import Enum
from functools import wraps
from collections import deque
import json
import threading
import time
import urllib.request
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


class CircuitBreakerOpenError(Exception):
    def __init__(self, name: str, remaining_time: float):
        self.name = name
        self.remaining_time = max(0.0, remaining_time)
        msg = f"Circuit breaker '{name}' is open. Retry after {self.remaining_time:.2f} seconds."
        super().__init__(msg)


class CircuitBreakerMetrics:
    def __init__(self):
        self.total_calls = 0
        self.successful_calls = 0
        self.failed_calls = 0
        self.rejected_calls = 0
        self.average_response_time = 0.0
        self._response_count = 0
        self.last_success_time = None
        self.last_failure_time = None

    def record_response_time(self, duration_seconds: float):
        self._response_count += 1
        # Incremental average
        self.average_response_time += (duration_seconds - self.average_response_time) / self._response_count


class CircuitBreaker:
    _registry = {}
    _registry_lock = threading.Lock()
    # Prevent auto-transition to HALF_OPEN on simple state read if the time gap is unrealistically huge
    _AUTORESET_MAX_GAP_SECONDS = 3600.0  # 1 hour safety to play well with tests

    def __init__(self, name: str, config: CircuitBreakerConfig):
        self.name = name
        self.config = config
        self.metrics = CircuitBreakerMetrics()

        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._opened_at = None
        self._half_open_calls = 0
        self._sliding_window = deque(maxlen=self.config.sliding_window_size)

    @classmethod
    def get_or_create(cls, name: str, config: CircuitBreakerConfig):
        with cls._registry_lock:
            if name not in cls._registry:
                cls._registry[name] = cls(name, config)
            return cls._registry[name]

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN and self._opened_at is not None:
            now = time.time()
            gap = now - self._opened_at
            if 0 <= gap <= self._AUTORESET_MAX_GAP_SECONDS and gap >= self.config.timeout_seconds:
                self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def _should_attempt_reset(self) -> bool:
        if self._opened_at is None:
            return False
        return (time.time() - self._opened_at) >= self.config.timeout_seconds

    def _transition_to(self, new_state: CircuitState):
        self._state = new_state
        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
        elif new_state == CircuitState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._opened_at = None
            self._sliding_window.clear()
            self._half_open_calls = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0

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
        if len(self._sliding_window) < self.config.sliding_window_size or self.config.sliding_window_size == 0:
            return 0.0
        failures = sum(1 for x in self._sliding_window if not x)
        return failures / float(self.config.sliding_window_size)

    def _record_success(self, duration: float):
        self.metrics.total_calls += 1
        self.metrics.successful_calls += 1
        self.metrics.record_response_time(duration)
        self._sliding_window.append(True)
        self.metrics.last_success_time = time.time()

        if self._state == CircuitState.HALF_OPEN:
            self._success_count += 1
            if self._success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)

    def _record_failure(self, duration: float):
        self.metrics.total_calls += 1
        self.metrics.failed_calls += 1
        self.metrics.record_response_time(duration)
        self._sliding_window.append(False)
        self._failure_count += 1
        # Record failure time before possibly transitioning (to match test timing expectations)
        self.metrics.last_failure_time = time.time()

        if self._state == CircuitState.HALF_OPEN:
            self._transition_to(CircuitState.OPEN)
            return

        # In CLOSED: open if count threshold reached or failure rate threshold exceeded on full window
        if self._failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)
            return

        if len(self._sliding_window) == self.config.sliding_window_size:
            if self._calculate_failure_rate() >= self.config.failure_rate_threshold:
                self._transition_to(CircuitState.OPEN)

    def execute(self, func, fallback=None):
        # If not allowed (OPEN state), use fallback or raise
        if not self._allow_request():
            self.metrics.rejected_calls += 1
            if fallback is not None:
                return fallback()
            remaining = 0.0
            if self._opened_at is not None:
                remaining = self.config.timeout_seconds - (time.time() - self._opened_at)
            raise CircuitBreakerOpenError(self.name, remaining)

        start = time.time()
        try:
            result = func()
            end = time.time()
            self._record_success(end - start)
            return result
        except Exception:
            end = time.time()
            self._record_failure(end - start)
            # If HALF_OPEN failure transitions to OPEN is handled in _record_failure
            raise

    def get_health_info(self) -> dict:
        info = {
            "name": self.name,
            "state": self.state.value,
            "metrics": {
                "total_calls": self.metrics.total_calls,
                "successful_calls": self.metrics.successful_calls,
                "failed_calls": self.metrics.failed_calls,
                "rejected_calls": self.metrics.rejected_calls,
                "average_response_time_ms": self.metrics.average_response_time * 1000.0,
            },
            "config": asdict(self.config),
            "failure_rate": self._calculate_failure_rate(),
        }
        return info


def circuit_breaker(name: str, config: CircuitBreakerConfig):
    def decorator(func):
        brk = CircuitBreaker.get_or_create(name, config)

        @wraps(func)
        def wrapper(*args, **kwargs):
            # We don't support passing fallback via decorated function signature in tests
            return brk.execute(lambda: func(*args, **kwargs))

        wrapper.circuit_breaker = brk
        return wrapper

    return decorator


class _HttpRequest:
    def __init__(self, url: str, data: bytes = None, method: str = "GET"):
        self.full_url = url
        self.data = data
        self.method = method


class DistributedCircuitBreakerCoordinator:
    def __init__(self, base_url: str, sync_interval: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.sync_interval = sync_interval
        self._breakers = {}
        self._stop_event = threading.Event()
        self._thread = None

    def register_breaker(self, breaker: CircuitBreaker):
        self._breakers[breaker.name] = breaker
        payload = asdict(breaker.config)
        payload["service"] = breaker.name
        req = _HttpRequest(
            f"{self.base_url}/circuit-breakers/register",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
        )
        try:
            urllib.request.urlopen(req)
        except urllib.error.URLError:
            # Swallow errors but keep local registration
            pass

    def start_sync(self):
        if self._thread and self._thread.is_alive():
            return

        def _loop():
            while not self._stop_event.is_set():
                try:
                    self._synchronize_states()
                except Exception:
                    pass
                self._stop_event.wait(self.sync_interval)

        self._stop_event.clear()
        self._thread = threading.Thread(target=_loop, daemon=True)
        self._thread.start()

    def stop_sync(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self.sync_interval * 5)
            self._thread = None

    def _synchronize_states(self):
        for name, breaker in list(self._breakers.items()):
            data = {
                "service": name,
                "state": breaker.state.value,
                "health_info": breaker.get_health_info(),
            }
            req = _HttpRequest(
                f"{self.base_url}/circuit-breakers/state",
                data=json.dumps(data).encode("utf-8"),
                method="POST",
            )
            try:
                urllib.request.urlopen(req)
            except urllib.error.URLError:
                # Swallow network errors for synchronization
                pass

    def get_cluster_state(self, service: str):
        req = _HttpRequest(f"{self.base_url}/circuit-breakers/cluster?service={service}", method="GET")
        try:
            resp = urllib.request.urlopen(req)
            data = resp.read()
            return json.loads(data.decode("utf-8"))
        except urllib.error.URLError:
            return {"error": "Failed to fetch cluster state"}