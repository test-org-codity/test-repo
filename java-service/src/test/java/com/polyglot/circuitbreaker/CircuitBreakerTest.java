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
                "test-breaker",
                3,  // failureThreshold
                2,  // successThreshold
                java.time.Duration.ofMillis(120), // timeout
                java.time.Duration.ofMillis(50)   // halfOpenTimeout (currently unused by implementation)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor: should start CLOSED with zero failure count and allow requests")
    void constructor_shouldStartClosed() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertTrue(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals("test-breaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create(name): should create a breaker in CLOSED state and execute operation successfully")
    void create_shouldCreateAndExecute() {
        CircuitBreaker<String> cb = CircuitBreaker.create("created");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
        assertTrue(cb.allowRequest());

        String result = cb.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    @DisplayName("getOrCreate(name,...): should return the same instance for same name and keep initial configuration")
    void getOrCreate_shouldReturnSameInstanceForSameName() {
        CircuitBreaker<String> first = CircuitBreaker.getOrCreate(
                "registry-name",
                1,
                1,
                java.time.Duration.ofMillis(10)
        );

        CircuitBreaker<String> second = CircuitBreaker.getOrCreate(
                "registry-name",
                999,
                999,
                java.time.Duration.ofSeconds(5)
        );

        assertSame(first, second, "Expected registry to return same instance for same name");

        // Prove original thresholds are retained: failureThreshold=1 should open after one failure.
        assertEquals(CircuitBreaker.State.CLOSED, first.getState());
        assertThrows(RuntimeException.class, () -> first.execute(() -> { throw new RuntimeException("fail"); }));
        assertEquals(CircuitBreaker.State.OPEN, first.getState());
    }

    @Test
    @DisplayName("allowRequest: should allow when CLOSED")
    void allowRequest_shouldAllowWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("recordFailure: should increment failure count while CLOSED and open when threshold reached")
    void recordFailure_shouldOpenWhenThresholdReached() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure(); // threshold=3 -> OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(3, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
        assertNotNull(metrics.lastFailureTime());
        assertTrue(!metrics.lastFailureTime().equals(java.time.Instant.MIN), "Expected lastFailureTime to be updated");
    }

    @Test
    @DisplayName("execute: should return supplier result and keep breaker CLOSED on success")
    void execute_shouldReturnResultOnSuccess() {
        String result = circuitBreaker.execute(() -> "value");
        assertEquals("value", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute: should propagate supplier exception and record failure")
    void execute_shouldPropagateExceptionAndRecordFailure() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> { throw new RuntimeException("boom"); })
        );
        assertEquals("boom", ex.getMessage());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.lastFailureTime());
        assertTrue(!metrics.lastFailureTime().equals(java.time.Instant.MIN));
    }

    @Test
    @DisplayName("execute: should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void execute_shouldShortCircuitWhenOpen() {
        // Open the circuit (threshold=3)
        circuitBreaker.recordFailure();
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
    @DisplayName("allowRequest: when OPEN should deny requests before timeout elapses")
    void allowRequest_openBeforeTimeout_shouldDeny() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest(), "Should deny immediately after opening (timeout not elapsed)");
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest: when OPEN and timeout elapsed should transition to HALF_OPEN and allow")
    void allowRequest_openAfterTimeout_shouldTransitionToHalfOpen() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait until timeout passes, then allowRequest should flip to HALF_OPEN
        Thread.sleep(150);

        assertTrue(circuitBreaker.allowRequest(), "Expected allowRequest to allow and transition to HALF_OPEN after timeout");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt remains set until reset() occurs");
        assertEquals(0, metrics.successCount(), "Expected successCount to be reset to 0 when transitioning to HALF_OPEN");
    }

    @Test
    @DisplayName("recordSuccess: in CLOSED should reset failureCount back to 0")
    void recordSuccess_closedShouldResetFailures() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordSuccess: in HALF_OPEN should close after reaching success threshold and reset counters/openedAt")
    void recordSuccess_halfOpenShouldCloseAfterThreshold() throws Exception {
        // Open -> wait -> HALF_OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successes needed=2
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt(), "Expected openedAt to be cleared on reset()");
    }

    @Test
    @DisplayName("recordFailure: in HALF_OPEN should immediately transition back to OPEN and set openedAt")
    void recordFailure_halfOpenShouldReopen() throws Exception {
        // Open -> wait -> HALF_OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("execute: in HALF_OPEN should count successes and close after threshold via execute path")
    void execute_halfOpenSuccessesShouldClose() throws Exception {
        // Open -> wait -> allow transitions to HALF_OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        assertEquals("a", circuitBreaker.execute(() -> "a"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState(), "Not enough successes yet to close");

        assertEquals("b", circuitBreaker.execute(() -> "b"));
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState(), "Expected to close after reaching success threshold");
        assertEquals(0, circuitBreaker.getFailureCount());
        assertNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("getMetrics: should reflect state, counts, and timestamps after failures/opening")
    void getMetrics_shouldReflectCurrentState() {
        CircuitBreaker.CircuitBreakerMetrics initial = circuitBreaker.getMetrics();
        assertEquals("test-breaker", initial.name());
        assertEquals(CircuitBreaker.State.CLOSED, initial.state());
        assertEquals(0, initial.failureCount());
        assertEquals(0, initial.successCount());
        assertNull(initial.openedAt());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics afterOneFailure = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, afterOneFailure.state());
        assertEquals(1, afterOneFailure.failureCount());
        assertNotNull(afterOneFailure.lastFailureTime());
        assertTrue(!afterOneFailure.lastFailureTime().equals(java.time.Instant.MIN));
        assertNull(afterOneFailure.openedAt());

        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens
        CircuitBreaker.CircuitBreakerMetrics afterOpen = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, afterOpen.state());
        assertEquals(3, afterOpen.failureCount());
        assertNotNull(afterOpen.openedAt());
    }
}