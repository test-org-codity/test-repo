package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<Integer> cb;
    private String name;
    private java.time.Duration timeout;
    private java.time.Duration halfOpenTimeout;

    @BeforeEach
    void setUp() {
        name = "cb-" + System.nanoTime();
        timeout = java.time.Duration.ofMillis(100);
        halfOpenTimeout = java.time.Duration.ofMillis(50);
        cb = new CircuitBreaker<>(name, 2, 2, timeout, halfOpenTimeout);
    }

    @AfterEach
    void tearDown() {
        cb = null;
    }

    @Test
    @DisplayName("Initial state should be CLOSED with zero counts and default metrics")
    void testInitialStateAndMetrics() {
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
        assertEquals(0, cb.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(name, metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should return result on success and keep CLOSED state")
    void testExecute_Success() {
        Integer result = cb.execute(() -> 123);
        assertEquals(123, result);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute failures should increment failure count and OPEN at threshold")
    void testExecute_FailureIncrementsAndOpensAtThreshold() {
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("boom1");
        }));
        assertEquals(1, cb.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("boom2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertTrue(metrics.lastFailureTime().isAfter(java.time.Instant.MIN));
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN")
    void testExecute_WhenOpenThrowsCircuitBreakerOpenException() {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f1");
        }));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Should be blocked
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> 42));
    }

    @Test
    @DisplayName("allowRequest should transition to HALF_OPEN after timeout when OPEN")
    void testAllowRequest_TransitionsToHalfOpenAfterTimeout() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f1");
        }));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());

        // Wait for timeout to elapse
        Thread.sleep(timeout.toMillis() + 50);

        boolean allowed = cb.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
    }

    @Test
    @DisplayName("Two successful operations in HALF_OPEN should CLOSE and reset counts")
    void testHalfOpen_SuccessesCloseAndResetCounts() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f1");
        }));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Wait and perform first successful trial -> remains HALF_OPEN
        Thread.sleep(timeout.toMillis() + 50);
        Integer v1 = cb.execute(() -> 1);
        assertEquals(1, v1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
        CircuitBreaker.CircuitBreakerMetrics afterFirst = cb.getMetrics();
        assertEquals(1, afterFirst.successCount());

        // Second success -> should CLOSE and reset counts
        Integer v2 = cb.execute(() -> 2);
        assertEquals(2, v2);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics afterClose = cb.getMetrics();
        assertEquals(0, afterClose.successCount());
        assertNull(afterClose.openedAt());
    }

    @Test
    @DisplayName("Failure in HALF_OPEN should immediately reopen to OPEN")
    void testHalfOpen_FailureReopensImmediately() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f1");
        }));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("f2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Wait for timeout, then fail once in HALF_OPEN -> should go back to OPEN
        Thread.sleep(timeout.toMillis() + 50);
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("trial-failure");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertNotNull(cb.getMetrics().openedAt());
    }

    @Test
    @DisplayName("recordSuccess should reset failure count when CLOSED")
    void testRecordSuccess_ResetsFailuresInClosed() {
        cb.recordFailure();
        assertEquals(1, cb.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        cb.recordSuccess();
        assertEquals(0, cb.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    @DisplayName("getOrCreate should return the same instance for the same name")
    void testGetOrCreate_ReturnsSameInstanceForSameName() {
        String sharedName = "shared-" + System.nanoTime();
        CircuitBreaker<String> c1 = CircuitBreaker.getOrCreate(sharedName, 3, 2, java.time.Duration.ofMillis(50));
        CircuitBreaker<String> c2 = CircuitBreaker.getOrCreate(sharedName, 10, 5, java.time.Duration.ofSeconds(1));

        assertSame(c1, c2);
        assertEquals("ok", c1.execute(() -> "ok"));
        assertEquals(CircuitBreaker.State.CLOSED, c1.getState());
    }

    @Test
    @DisplayName("Factory create should produce a CLOSED breaker that executes successfully")
    void testCreateFactory_ProducesClosedBreaker() {
        CircuitBreaker<String> defaultCb = CircuitBreaker.create("default-" + System.nanoTime());
        assertEquals(CircuitBreaker.State.CLOSED, defaultCb.getState());
        assertEquals("value", defaultCb.execute(() -> "value"));
    }

    @Test
    @DisplayName("Metrics should reflect lastFailureTime and openedAt across transitions")
    void testMetricsReflectStateAndTimestamps() {
        // One failure -> still CLOSED; lastFailureTime updated; openedAt null
        cb.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m1 = cb.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, m1.state());
        assertEquals(1, m1.failureCount());
        assertTrue(m1.lastFailureTime().isAfter(java.time.Instant.MIN));
        assertNull(m1.openedAt());

        // Next failure -> OPEN; openedAt set
        cb.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m2 = cb.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m2.state());
        assertNotNull(m2.openedAt());
    }

    @Test
    @DisplayName("allowRequest should be true in CLOSED and false in OPEN before timeout")
    void testAllowRequest_ClosedTrueOpenFalseBeforeTimeout() {
        assertTrue(cb.allowRequest());

        // Open the breaker
        cb.recordFailure();
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());
    }
}