package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;

    @BeforeEach
    void setUp() {
        circuitBreaker = new CircuitBreaker<>("testBreaker", 3, 2, Duration.ofMillis(200), Duration.ofMillis(100));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance with CLOSED state")
    void testConstructor() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should run operation and record success in CLOSED state")
    void testExecuteSuccessInClosedState() {
        String result = circuitBreaker.execute(() -> "success");
        assertEquals("success", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should record failure and rethrow exception")
    void testExecuteFailureInClosedState() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                })
        );
        assertEquals("failure", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should open circuit after reaching failure threshold")
    void testExecuteOpensCircuitAfterFailures() {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(3, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when circuit is OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpenAndTimeoutNotElapsed() {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "should not run")
        );
    }

    @Test
    @DisplayName("allowRequest should return true in CLOSED state")
    void testAllowRequestInClosedState() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should return false in OPEN state before timeout")
    void testAllowRequestInOpenStateBeforeTimeout() {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should transition from OPEN to HALF_OPEN after timeout")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN should close circuit after reaching success threshold")
    void testRecordSuccessClosesFromHalfOpen() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessResetsFailuresInClosed() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN should transition back to OPEN")
    void testRecordFailureFromHalfOpenToOpen() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in CLOSED should open circuit after threshold")
    void testRecordFailureOpensCircuitFromClosed() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(3, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getState should reflect current circuit state transitions")
    void testGetState() throws InterruptedException {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount should return correct number of failures")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should return consistent metrics in CLOSED state")
    void testGetMetricsInClosedState() {
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertEquals(Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("getMetrics should reflect failures and OPEN state")
    void testGetMetricsAfterFailuresAndOpen() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertEquals(3, metrics.failureCount());
        assertTrue(metrics.lastFailureTime().isAfter(Instant.MIN));
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should increment successCount in HALF_OPEN and then reset on close")
    void testSuccessCountBehaviorInHalfOpen() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);

        circuitBreaker.execute(() -> "ok1");
        CircuitBreaker.CircuitBreakerMetrics metricsAfterFirst = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metricsAfterFirst.state());
        assertEquals(1, metricsAfterFirst.successCount());

        circuitBreaker.execute(() -> "ok2");
        CircuitBreaker.CircuitBreakerMetrics metricsAfterSecond = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metricsAfterSecond.state());
        assertEquals(0, metricsAfterSecond.successCount());
    }

    @Test
    @DisplayName("execute should not run supplier when circuit is OPEN and not ready to reset")
    void testExecuteDoesNotRunSupplierWhenOpen() {
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        AtomicBoolean executed = new AtomicBoolean(false);
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> {
                    executed.set(true);
                    return "should not run";
                })
        );
        assertFalse(executed.get());
    }

    @Test
    @DisplayName("create factory method should create circuit breaker with default settings")
    void testCreateFactoryMethod() {
        CircuitBreaker<Integer> cb = CircuitBreaker.create("factoryBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate("sharedBreaker", 2, 1, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate("sharedBreaker", 5, 3, Duration.ofSeconds(5));

        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("getOrCreate should create different instances for different names")
    void testGetOrCreateDifferentNames() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate("breaker1", 2, 1, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate("breaker2", 2, 1, Duration.ofSeconds(1));

        assertNotSame(cb1, cb2);
    }

    @Test
    @DisplayName("CircuitBreakerOpenException should store message")
    void testCircuitBreakerOpenExceptionMessage() {
        CircuitBreaker.CircuitBreakerOpenException ex =
                new CircuitBreaker.CircuitBreakerOpenException("open");
        assertEquals("open", ex.getMessage());
    }
}