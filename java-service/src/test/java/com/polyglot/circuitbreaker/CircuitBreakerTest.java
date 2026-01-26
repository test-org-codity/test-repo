package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<Integer> circuitBreaker;
    private final java.time.Duration timeout = java.time.Duration.ofMillis(200);
    private final java.time.Duration halfOpenTimeout = java.time.Duration.ofMillis(50); // not used by implementation

    @BeforeEach
    void setUp() {
        // failureThreshold = 2, successThreshold = 2 for faster state transitions in tests
        circuitBreaker = new CircuitBreaker<>("test", 2, 2, timeout, halfOpenTimeout);
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state should be CLOSED and metrics initialized")
    void testInitialStateAndMetrics() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest(), "Initial allowRequest should be true in CLOSED state");
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("test", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should return value on success and keep breaker CLOSED")
    void testExecuteSuccess() {
        Integer result = circuitBreaker.execute(() -> 42);
        assertEquals(42, result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount(), "Failure count should be reset on success in CLOSED");
    }

    @Test
    @DisplayName("execute should record failure and rethrow exception")
    void testExecuteFailureIncrementsAndRethrows() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom"); })
        );
        assertEquals("boom", ex.getMessage());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState(), "Should remain CLOSED until threshold reached");
        assertEquals(1, circuitBreaker.getFailureCount(), "Failure count should increment after failure");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, metrics.lastFailureTime(), "lastFailureTime should be updated after failure");
    }

    @Test
    @DisplayName("Breaker should transition to OPEN after reaching failure threshold")
    void testOpenAfterFailureThreshold() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // threshold = 2

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest(), "Requests should be denied while OPEN before timeout");
        assertEquals(2, circuitBreaker.getFailureCount(), "Failure count should reflect threshold when OPEN");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt(), "openedAt should be set when breaker opens");
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and before timeout")
    void testExecuteWhenOpenThrowsOpenException() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // now OPEN

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
            circuitBreaker.execute(() -> 1)
        );
    }

    @Test
    @DisplayName("allowRequest should transition to HALF_OPEN after timeout elapses")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // now OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(timeout.toMillis() + 100); // wait past timeout
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed, "Request should be allowed after timeout");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState(), "State should transition to HALF_OPEN after timeout");
    }

    @Test
    @DisplayName("Successful calls in HALF_OPEN reaching threshold should close the breaker")
    void testHalfOpenSuccessesCloseBreaker() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to allow HALF_OPEN
        Thread.sleep(timeout.toMillis() + 100);

        // First success via execute should set state to HALF_OPEN and increment successCount
        Integer r1 = circuitBreaker.execute(() -> 1);
        assertEquals(1, r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState(), "Should remain HALF_OPEN after first success (successThreshold=2)");

        // Second success should close the breaker
        Integer r2 = circuitBreaker.execute(() -> 2);
        assertEquals(2, r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState(), "Should transition to CLOSED after reaching success threshold");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNull(metrics.openedAt(), "openedAt should be cleared when breaker closes");
        assertEquals(0, circuitBreaker.getFailureCount(), "Failure count should be reset on closing");
    }

    @Test
    @DisplayName("Failure while HALF_OPEN should immediately reopen the breaker")
    void testHalfOpenFailureReopens() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and allow HALF_OPEN
        Thread.sleep(timeout.toMillis() + 100);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // A failure in HALF_OPEN reopens immediately
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt(), "openedAt should be set when breaker reopens from HALF_OPEN");
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessResetsFailureCountInClosed() {
        // Accumulate a single failure (below threshold)
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        // A success should reset failure count
        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getOrCreate should return the same instance for the same name")
    void testGetOrCreateReturnsSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.<String>getOrCreate("shared", 3, 1, java.time.Duration.ofMillis(100));
        CircuitBreaker<Integer> cb2 = CircuitBreaker.<Integer>getOrCreate("shared", 5, 5, java.time.Duration.ofSeconds(1));

        assertSame(cb1, cb2, "getOrCreate should return the same instance for the same name regardless of generic type");

        CircuitBreaker.CircuitBreakerMetrics metrics = cb1.getMetrics();
        assertEquals("shared", metrics.name());
    }

    @Test
    @DisplayName("Factory create should initialize a CLOSED breaker that allows requests")
    void testCreateFactoryDefaults() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factory");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
    }
}