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
        circuitBreaker = new CircuitBreaker<>("test-breaker", 2, 2,
                java.time.Duration.ofMillis(50),
                java.time.Duration.ofMillis(10));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should initialize to CLOSED with zero failure count")
    void testConstructorInitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("test-breaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create(name) should return a non-null instance and start CLOSED")
    void testCreateFactoryMethod() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factory");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals("factory", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
    }

    @Test
    @DisplayName("getOrCreate should return the same instance for the same name")
    void testGetOrCreateReturnsSameInstanceForSameName() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate("shared", 1, 1, java.time.Duration.ofMillis(5));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate("shared", 5, 3, java.time.Duration.ofSeconds(1));

        assertSame(cb1, cb2);
        assertEquals("shared", cb1.getMetrics().name());
    }

    @Test
    @DisplayName("allowRequest should return true when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should return supplier result and keep CLOSED on success")
    void testExecuteSuccessWhenClosed() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
    }

    @Test
    @DisplayName("execute should rethrow exception from supplier and record failure")
    void testExecuteFailureWhenClosedRethrowsAndCountsFailure() {
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
    @DisplayName("recordFailure should open circuit once failure threshold is reached")
    void testRecordFailureOpensAtThreshold() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
        assertTrue(metrics.openedAt().equals(java.time.Instant.MIN) == false);
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsCircuitBreakerOpenExceptionWhenOpenAndNotTimedOut() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> "should-not-run")
        );
        assertTrue(ex.getMessage().contains("test-breaker"));
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenAndNotTimedOut() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should transition OPEN -> HALF_OPEN after timeout elapses")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);

        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
    }

    @Test
    @DisplayName("In HALF_OPEN, recordSuccess should close circuit after success threshold and reset counts")
    void testHalfOpenSuccessClosesAfterThresholdAndResetsCounts() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold is 2
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount(), "failureCount is not reset until fully CLOSED via reset()");

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("In HALF_OPEN, recordFailure should transition to OPEN and set openedAt")
    void testHalfOpenFailureReopensCircuit() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count to zero")
    void testRecordSuccessInClosedResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should reflect lastFailureTime update after failure")
    void testGetMetricsReflectsLastFailureTimeAfterFailure() throws Exception {
        java.time.Instant before = java.time.Instant.now();
        Thread.sleep(2);

        circuitBreaker.recordFailure();

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.lastFailureTime());
        assertTrue(!metrics.lastFailureTime().isBefore(before), "lastFailureTime should be >= time captured before failure");
        assertEquals(1, metrics.failureCount());
    }

    @Test
    @DisplayName("execute in HALF_OPEN should count successes and close after threshold via execute()")
    void testExecuteInHalfOpenClosesAfterSuccessThreshold() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        assertEquals("a", circuitBreaker.execute(() -> "a"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        assertEquals("b", circuitBreaker.execute(() -> "b"));
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }
}