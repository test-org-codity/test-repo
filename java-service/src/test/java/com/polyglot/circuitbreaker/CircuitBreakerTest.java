package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;

    @BeforeEach
    void setUp() {
        // Small thresholds/timeouts keep tests fast and deterministic.
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker",
                2, // failureThreshold
                2, // successThreshold
                java.time.Duration.ofMillis(50), // timeout
                java.time.Duration.ofSeconds(10) // halfOpenTimeout (not used by implementation but required by ctor)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should initialize in CLOSED state with zero counts and allow requests")
    void testConstructor_InitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertTrue(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create(name) should return a non-null breaker in CLOSED state")
    void testCreateFactory() {
        CircuitBreaker<Integer> cb = CircuitBreaker.create("factoryBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
        assertEquals(0, cb.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals("factoryBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name (registry caching)")
    void testGetOrCreate_CachesByName() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registryBreaker",
                1,
                1,
                java.time.Duration.ofMillis(1)
        );
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "registryBreaker",
                999,
                999,
                java.time.Duration.ofDays(1)
        );

        assertSame(cb1, cb2, "Expected getOrCreate to return the same instance for identical name");
    }

    @Test
    @DisplayName("execute should run supplier, return result, and keep breaker CLOSED")
    void testExecute_Success() {
        String result = circuitBreaker.execute(() -> "OK");
        assertEquals("OK", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should rethrow operation exception and record failure")
    void testExecute_FailureRethrowsAndRecordsFailure() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("boom");
        }));
        assertEquals("boom", ex.getMessage());

        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState(), "Should still be CLOSED after 1 failure with threshold 2");
        assertEquals(1, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(1, metrics.failureCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("recordFailure should open the circuit once failure threshold is reached")
    void testRecordFailure_OpensWhenThresholdReached() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt should be set when circuit opens");
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("allowRequest should be false while OPEN and timeout has not elapsed")
    void testAllowRequest_OpenBeforeTimeout_Denies() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest(), "Should deny while OPEN before timeout elapses");
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState(), "State should remain OPEN when denying request");
    }

    @Test
    @DisplayName("allowRequest should transition OPEN -> HALF_OPEN after timeout elapses")
    void testAllowRequest_OpenAfterTimeout_TransitionsToHalfOpen() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);

        assertTrue(circuitBreaker.allowRequest(), "After timeout, allowRequest should permit a probe request");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState(), "Expected transition to HALF_OPEN after timeout");
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecute_WhenOpen_ThrowsCircuitBreakerOpenException() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> "SHOULD_NOT_RUN")
        );

        assertTrue(ex.getMessage().contains("testBreaker"));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("HALF_OPEN should close after reaching success threshold and reset counts")
    void testHalfOpen_SuccessesCloseCircuitAndReset() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Success #1: should remain HALF_OPEN
        assertEquals("A", circuitBreaker.execute(() -> "A"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(1, m1.successCount());
        assertEquals(2, m1.failureCount(), "failureCount is not reset until closing via reset()");

        // Success #2: should transition to CLOSED and reset counts
        assertEquals("B", circuitBreaker.execute(() -> "B"));
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, m2.state());
        assertEquals(0, m2.failureCount());
        assertEquals(0, m2.successCount());
        assertNull(m2.openedAt(), "openedAt should be cleared after reset");
    }

    @Test
    @DisplayName("HALF_OPEN failure should immediately reopen and deny subsequent requests before timeout")
    void testHalfOpen_FailureReopensCircuit() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("probe failed");
        }));

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState(), "Failure in HALF_OPEN should reopen circuit");

        // Immediately after reopening, before timeout, should deny
        assertFalse(circuitBreaker.allowRequest(), "Should deny immediately after reopening");
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failureCount to zero")
    void testRecordSuccess_InClosed_ResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount(), "Success in CLOSED should clear failure count");
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getMetrics should reflect state transitions and timestamps")
    void testGetMetrics_ReflectsStateAndTimestamps() {
        CircuitBreaker.CircuitBreakerMetrics m0 = circuitBreaker.getMetrics();
        assertEquals("testBreaker", m0.name());
        assertEquals(CircuitBreaker.State.CLOSED, m0.state());
        assertEquals(0, m0.failureCount());
        assertEquals(0, m0.successCount());
        assertNull(m0.openedAt());
        assertNotNull(m0.lastFailureTime());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(1, m1.failureCount());
        assertNotNull(m1.lastFailureTime());

        circuitBreaker.recordFailure(); // opens
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m2.state());
        assertEquals(2, m2.failureCount());
        assertNotNull(m2.openedAt());
        assertNotNull(m2.lastFailureTime());
    }
}