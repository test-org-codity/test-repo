package com.polyglot.circuitbreaker;

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
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker",
                2, // failureThreshold
                2, // successThreshold
                java.time.Duration.ofMillis(50),  // timeout
                java.time.Duration.ofMillis(10)   // halfOpenTimeout (not currently used by implementation)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create a CLOSED circuit breaker with zero counts")
    void testConstructor_InitialStateAndCounts() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());

        // lastFailureTime is typically null until a failure occurs.
        assertNull(metrics.lastFailureTime(), "lastFailureTime should be null before any failures");
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create(name) should return a non-null breaker and allow requests initially")
    void testCreate_DefaultFactory() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factoryBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
    }

    @Test
    @DisplayName("getOrCreate(name, ...) should return the same instance for the same name")
    void testGetOrCreate_ReturnsSameInstanceForSameName() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registryBreaker",
                3,
                2,
                java.time.Duration.ofMillis(100)
        );
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "registryBreaker",
                99,
                99,
                java.time.Duration.ofSeconds(5)
        );

        assertSame(cb1, cb2, "Expected registry to return the same instance for the same name");
    }

    @Test
    @DisplayName("allowRequest should return true when state is CLOSED")
    void testAllowRequest_WhenClosed_ReturnsTrue() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should return supplier result and keep breaker CLOSED")
    void testExecute_Success_ReturnsResultAndResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        String result = circuitBreaker.execute(() -> "OK");

        assertEquals("OK", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount(), "Success in CLOSED should reset failureCount to 0");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(0, metrics.failureCount());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
    }

    @Test
    @DisplayName("execute should rethrow operation exception and record failure")
    void testExecute_Failure_RethrowsAndIncrementsFailureCount() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("boom");
        }));
        assertEquals("boom", ex.getMessage());

        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(1, metrics.failureCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("recordFailure should OPEN the breaker after reaching failureThreshold")
    void testRecordFailure_OpensAfterThreshold() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt should be set when breaker opens");
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when breaker is OPEN and timeout not elapsed")
    void testExecute_WhenOpen_ThrowsCircuitBreakerOpenException() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> "should not run")
        );
        assertTrue(ex.getMessage().contains("testBreaker"));
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout not elapsed")
    void testAllowRequest_WhenOpenAndNotTimedOut_ReturnsFalse() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("After timeout elapses, allowRequest should transition OPEN -> HALF_OPEN and allow the request")
    void testAllowRequest_OpenToHalfOpen_AfterTimeout() throws Exception {
        CircuitBreaker<String> cb = new CircuitBreaker<>(
                "timeoutBreaker",
                1,
                1,
                java.time.Duration.ofMillis(20),
                java.time.Duration.ofMillis(10)
        );

        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest(), "Before timeout, should not allow request");

        Thread.sleep(25);

        assertTrue(cb.allowRequest(), "After timeout, should allow and move to HALF_OPEN");
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
    }

    @Test
    @DisplayName("In HALF_OPEN, recordSuccess should close the breaker after reaching successThreshold and reset metrics")
    void testHalfOpen_SuccessClosesAfterThresholdAndResets() throws Exception {
        CircuitBreaker<String> cb = new CircuitBreaker<>(
                "halfOpenCloseBreaker",
                1,
                2,
                java.time.Duration.ofMillis(20),
                java.time.Duration.ofMillis(10)
        );

        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(25);
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        cb.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState(), "Not enough successes yet to close");

        // Implementation may keep failureCount as-is or reset it; success must not increase it.
        int failureAfterFirstSuccess = cb.getFailureCount();
        assertTrue(failureAfterFirstSuccess >= 0, "Failure count should never be negative");

        cb.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState(), "After enough successes, should close");

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount(), "reset() should clear successCount");
        assertNull(metrics.openedAt(), "reset() should clear openedAt");
    }

    @Test
    @DisplayName("In HALF_OPEN, a single failure should immediately reopen the breaker")
    void testHalfOpen_FailureReopensImmediately() throws Exception {
        CircuitBreaker<String> cb = new CircuitBreaker<>(
                "halfOpenFailBreaker",
                1,
                2,
                java.time.Duration.ofMillis(20),
                java.time.Duration.ofMillis(10)
        );

        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(25);
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState(), "Failure in HALF_OPEN should reopen circuit");

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt should be set when reopened");
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failureCount to 0 (even if previously incremented)")
    void testRecordSuccess_WhenClosed_ResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getMetrics should reflect state changes and timestamps when opened")
    void testGetMetrics_ReflectsOpenStateAndOpenedAt() {
        CircuitBreaker.CircuitBreakerMetrics before = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, before.state());
        assertNull(before.openedAt());

        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // open at threshold=2

        CircuitBreaker.CircuitBreakerMetrics after = circuitBreaker.getMetrics();
        assertEquals("testBreaker", after.name());
        assertEquals(CircuitBreaker.State.OPEN, after.state());
        assertEquals(2, after.failureCount());
        assertNotNull(after.lastFailureTime());
        assertNotNull(after.openedAt());
    }

    @Test
    @DisplayName("execute in HALF_OPEN should record successes and close after threshold via execute path")
    void testExecute_HalfOpen_ClosesAfterEnoughSuccessfulExecutions() throws Exception {
        CircuitBreaker<String> cb = new CircuitBreaker<>(
                "executeHalfOpenBreaker",
                1,
                2,
                java.time.Duration.ofMillis(20),
                java.time.Duration.ofMillis(10)
        );

        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(25);
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        assertEquals("A", cb.execute(() -> "A"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        assertEquals("B", cb.execute(() -> "B"));
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }
}