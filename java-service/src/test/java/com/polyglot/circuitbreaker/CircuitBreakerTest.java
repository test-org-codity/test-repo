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
        circuitBreaker = new CircuitBreaker<>(
                "test-cb",
                2,   // failureThreshold
                2,   // successThreshold
                java.time.Duration.ofMillis(50),  // timeout
                java.time.Duration.ofMillis(10)   // halfOpenTimeout (not used by implementation, but required by ctor)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance with initial CLOSED state and zero failure count")
    void testConstructor_initialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("test-cb", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("Static create(name) should build a non-null circuit breaker with provided name and CLOSED state")
    void testCreate_defaultConfiguration() {
        CircuitBreaker<String> cb = CircuitBreaker.create("created");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals("created", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("getOrCreate should return the same instance for the same name")
    void testGetOrCreate_returnsSameInstanceForSameName() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registry-cb",
                1,
                1,
                java.time.Duration.ofSeconds(1)
        );
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "registry-cb",
                99,
                99,
                java.time.Duration.ofSeconds(99)
        );

        assertSame(cb1, cb2, "Expected getOrCreate to return the same cached instance for the same name");
        assertEquals("registry-cb", cb2.getMetrics().name());
    }

    @Test
    @DisplayName("allowRequest should return true when CLOSED")
    void testAllowRequest_closed_returnsTrue() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should return operation result and keep state CLOSED on success")
    void testExecute_successInClosed_returnsResultAndResetsFailures() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");

        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should rethrow exceptions from operation and record failure")
    void testExecute_failureInClosed_rethrowsAndIncrementsFailureCount() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("boom");
                })
        );
        assertEquals("boom", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(1, metrics.failureCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("recordFailure should open the circuit when failureThreshold is reached")
    void testRecordFailure_reachesThreshold_opensCircuit() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout has not yet elapsed")
    void testAllowRequest_openBeforeTimeout_returnsFalse() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when circuit is OPEN and timeout not elapsed")
    void testExecute_open_throwsCircuitBreakerOpenException() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> "should-not-run")
        );

        assertTrue(ex.getMessage().contains("test-cb"));
    }

    @Test
    @DisplayName("allowRequest should transition from OPEN to HALF_OPEN after timeout elapses")
    void testAllowRequest_openAfterTimeout_transitionsToHalfOpen() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);

        assertTrue(circuitBreaker.allowRequest(), "After timeout, OPEN circuit should allow a trial request");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
        assertEquals(0, metrics.successCount(), "successCount should be reset when transitioning to HALF_OPEN");
    }

    @Test
    @DisplayName("In HALF_OPEN, recordSuccess should close the circuit after reaching successThreshold and reset counts")
    void testHalfOpen_successThreshold_closesAndResets() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(60);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metricsAfterOne = circuitBreaker.getMetrics();
        assertEquals(1, metricsAfterOne.successCount());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metricsAfterClose = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metricsAfterClose.state());
        assertEquals(0, metricsAfterClose.failureCount());
        assertEquals(0, metricsAfterClose.successCount(), "reset() should clear successCount on closing");
        assertNull(metricsAfterClose.openedAt(), "reset() should clear openedAt on closing");
    }

    @Test
    @DisplayName("In HALF_OPEN, recordFailure should immediately reopen the circuit and set openedAt")
    void testHalfOpen_failure_reopens() throws Exception {
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
    @DisplayName("recordSuccess in CLOSED should reset failureCount to zero")
    void testRecordSuccess_closed_resetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();

        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getMetrics should reflect current state, counts, lastFailureTime, and openedAt correctly")
    void testGetMetrics_reflectsStateAndTimes() {
        CircuitBreaker.CircuitBreakerMetrics m0 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, m0.state());
        assertEquals(0, m0.failureCount());
        assertEquals(0, m0.successCount());
        assertNull(m0.openedAt());
        assertNotNull(m0.lastFailureTime());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, m1.state());
        assertEquals(1, m1.failureCount());
        assertNotNull(m1.lastFailureTime());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m2.state());
        assertEquals(2, m2.failureCount());
        assertNotNull(m2.openedAt());
    }
}
