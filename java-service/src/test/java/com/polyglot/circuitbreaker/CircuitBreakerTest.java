package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> breaker;
    private String breakerName;
    private int failureThreshold;
    private int successThreshold;
    private java.time.Duration timeout;
    private java.time.Duration halfOpenTimeout;

    @BeforeEach
    void setUp() {
        breakerName = "test-" + System.nanoTime();
        failureThreshold = 3;
        successThreshold = 2;
        timeout = java.time.Duration.ofMillis(200);
        halfOpenTimeout = java.time.Duration.ofMillis(50);
        breaker = new CircuitBreaker<>(breakerName, failureThreshold, successThreshold, timeout, halfOpenTimeout);
    }

    @AfterEach
    void tearDown() {
        breaker = null;
    }

    private void sleepMillis(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(ie);
        }
    }

    private void openBreaker() {
        for (int i = 0; i < failureThreshold; i++) {
            breaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState(), "Breaker should be OPEN after reaching failure threshold");
    }

    private void moveToHalfOpenAfterTimeout() {
        openBreaker();
        assertFalse(breaker.allowRequest(), "Request should not be allowed while OPEN before timeout");

        sleepMillis(timeout.toMillis() + 50);
        boolean allowed = breaker.allowRequest();
        assertTrue(allowed, "Request should be allowed after timeout to attempt HALF_OPEN");
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState(), "State should transition to HALF_OPEN after timeout");
    }

    @Test
    @DisplayName("Initial state is CLOSED and allowRequest returns true")
    void testInitialStateAndAllowRequest() {
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
        assertTrue(breaker.allowRequest());
        assertEquals(0, breaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = breaker.getMetrics();
        assertEquals(breakerName, metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("recordFailure increments failure count and opens at threshold")
    void testRecordFailure_OpensAtThreshold() {
        for (int i = 1; i <= failureThreshold; i++) {
            breaker.recordFailure();
            if (i < failureThreshold) {
                assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
                assertEquals(i, breaker.getFailureCount());
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
        assertEquals(failureThreshold, breaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = breaker.getMetrics();
        assertNotNull(metrics.openedAt());
        assertNotEquals(java.time.Instant.MIN, metrics.lastFailureTime());
    }

    @Test
    @DisplayName("allowRequest returns false when OPEN before timeout elapses")
    void testAllowRequestFalseWhileOpenBeforeTimeout() {
        openBreaker();
        assertFalse(breaker.allowRequest());
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
    }

    @Test
    @DisplayName("OPEN transitions to HALF_OPEN after timeout via allowRequest")
    void testOpenToHalfOpenAfterTimeout() {
        openBreaker();
        sleepMillis(timeout.toMillis() + 50);

        boolean allowed = breaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = breaker.getMetrics();
        assertEquals(0, metrics.successCount(), "Success count should reset when entering HALF_OPEN");
    }

    @Test
    @DisplayName("In HALF_OPEN, allowRequest returns true")
    void testAllowRequestInHalfOpen() {
        moveToHalfOpenAfterTimeout();
        assertTrue(breaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, successes reaching threshold close the breaker and reset counters")
    void testHalfOpenSuccessesCloseBreaker() {
        moveToHalfOpenAfterTimeout();

        breaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState(), "Still HALF_OPEN until success threshold reached");

        breaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState(), "Should close after reaching success threshold");

        CircuitBreaker.CircuitBreakerMetrics metrics = breaker.getMetrics();
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure reopens the breaker immediately")
    void testHalfOpenFailureReopens() {
        moveToHalfOpenAfterTimeout();

        breaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
        assertFalse(breaker.allowRequest(), "Should not allow request immediately after reopening");
        assertNotNull(breaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("execute returns value on success and resets failure count in CLOSED")
    void testExecuteSuccessResetsFailureCount() {
        breaker.recordFailure();
        assertEquals(1, breaker.getFailureCount());

        String result = breaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, breaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
    }

    @Test
    @DisplayName("execute rethrows on failure and increments failure count")
    void testExecuteFailureRethrowsAndIncrements() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            breaker.execute(() -> { throw new RuntimeException("boom"); });
        });
        assertEquals("boom", ex.getMessage());
        assertEquals(1, breaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
    }

    @Test
    @DisplayName("execute throws CircuitBreakerOpenException when OPEN and before timeout")
    void testExecuteThrowsWhenOpen() {
        openBreaker();
        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
            CircuitBreaker.CircuitBreakerOpenException.class,
            () -> breaker.execute(() -> "shouldNotRun")
        );
        assertTrue(ex.getMessage().contains(breakerName));
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name")
    void testGetOrCreateRegistrySameInstance() {
        String name = "reg-" + System.nanoTime();
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(name, 5, 3, java.time.Duration.ofMillis(100));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(name, 10, 10, java.time.Duration.ofSeconds(1));
        assertSame(a, b, "Should return same instance for same name");
    }

    @Test
    @DisplayName("getOrCreate respects provided failure threshold")
    void testGetOrCreateRespectsFailureThreshold() {
        String name = "reg-threshold-" + System.nanoTime();
        CircuitBreaker<String> cb = CircuitBreaker.getOrCreate(name, 1, 2, java.time.Duration.ofMillis(200));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState(), "With threshold 1, first failure should open the breaker");
    }

    @Test
    @DisplayName("Metrics reflect lastFailureTime, openedAt and counts")
    void testMetricsReflectsUpdates() {
        CircuitBreaker.CircuitBreakerMetrics initial = breaker.getMetrics();
        assertEquals(java.time.Instant.MIN, initial.lastFailureTime());
        assertNull(initial.openedAt());
        assertEquals(0, initial.failureCount());
        assertEquals(0, initial.successCount());

        breaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics afterFailure = breaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, afterFailure.lastFailureTime());
        assertNull(afterFailure.openedAt());
        assertEquals(1, afterFailure.failureCount());

        openBreaker();
        CircuitBreaker.CircuitBreakerMetrics afterOpen = breaker.getMetrics();
        assertNotNull(afterOpen.openedAt());
        assertEquals(CircuitBreaker.State.OPEN, afterOpen.state());
    }

    @Test
    @DisplayName("Immediate open when failure threshold is 1")
    void testImmediateOpenWithThresholdOne() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("one-" + System.nanoTime(), 1, 1, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState(), "Breaker should open on first failure when threshold is 1");
    }
}