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
                3,                      // failureThreshold
                2,                      // successThreshold
                java.time.Duration.ofMillis(50),   // timeout
                java.time.Duration.ofMillis(10)    // halfOpenTimeout (currently unused by logic)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should initialize in CLOSED state with zero counters")
    void testConstructor_InitialStateAndCounters() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals("test-breaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create(name) should return a non-null CircuitBreaker with provided name in metrics")
    void testCreate_DefaultFactory() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factory");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals("factory", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name (registry caching)")
    void testGetOrCreate_ReturnsSameInstanceForSameName() {
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(
                "shared",
                2,
                1,
                java.time.Duration.ofMillis(10)
        );
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(
                "shared",
                999,
                999,
                java.time.Duration.ofSeconds(999)
        );

        assertSame(a, b, "Expected getOrCreate to return cached instance for same name");
        assertEquals("shared", a.getMetrics().name());
        assertEquals(CircuitBreaker.State.CLOSED, a.getState());
    }

    @Test
    @DisplayName("allowRequest should return true when CLOSED")
    void testAllowRequest_WhenClosed_ReturnsTrue() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should run operation and record success in CLOSED (clears failures)")
    void testExecute_SuccessInClosed_ClearsFailureCount() {
        // Create a failure first to increment failureCount
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("boom");
        }));
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount(), "Success in CLOSED should reset failureCount to 0");
    }

    @Test
    @DisplayName("execute should rethrow operation exception and record failure")
    void testExecute_Failure_RethrowsAndRecordsFailure() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("failure");
        }));
        assertEquals("failure", ex.getMessage());

        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(1, metrics.failureCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("recordFailure should open circuit when failureThreshold reached")
    void testRecordFailure_OpensWhenThresholdReached() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(3, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt should be set when circuit transitions to OPEN");
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecute_WhenOpenBeforeTimeout_ThrowsCircuitBreakerOpenException() {
        // Trip to OPEN (threshold = 3)
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> "should not run")
        );

        assertTrue(ex.getMessage().contains("test-breaker"));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState(), "Should remain OPEN before timeout");
    }

    @Test
    @DisplayName("allowRequest should transition from OPEN to HALF_OPEN after timeout")
    void testAllowRequest_OpenToHalfOpen_AfterTimeout() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait long enough for timeout (50ms) to elapse
        Thread.sleep(70);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed, "After timeout, allowRequest should permit a trial request");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
        assertEquals(0, metrics.successCount(), "On transition to HALF_OPEN, successCount should reset to 0");
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN should close circuit after successThreshold and reset counters")
    void testHalfOpen_SuccessesCloseAndReset() throws Exception {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(70);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold = 2
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(3, circuitBreaker.getFailureCount(), "Failure count is not reset until fully closed");

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount(), "After closing, reset() should clear failureCount");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt(), "After reset(), openedAt should be null");
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN should immediately reopen circuit and set openedAt")
    void testHalfOpen_FailureReopensImmediately() throws Exception {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(70);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt(), "openedAt should be set when HALF_OPEN transitions to OPEN on failure");
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failureCount to 0")
    void testRecordSuccess_Closed_ResetsFailureCount() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount(), "recordSuccess in CLOSED should clear failureCount");
    }

    @Test
    @DisplayName("getMetrics should reflect state transitions and timestamps")
    void testGetMetrics_ReflectsStateAndTimestamps() {
        CircuitBreaker.CircuitBreakerMetrics initial = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, initial.state());
        assertNotNull(initial.lastFailureTime());
        assertNull(initial.openedAt());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics afterFailure = circuitBreaker.getMetrics();
        assertEquals(1, afterFailure.failureCount());
        assertNotNull(afterFailure.lastFailureTime());

        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens at threshold 3
        CircuitBreaker.CircuitBreakerMetrics afterOpen = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, afterOpen.state());
        assertNotNull(afterOpen.openedAt());
    }
}