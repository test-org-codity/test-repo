package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;

    @BeforeEach
    void setUp() {
        // Use small thresholds and timeouts to make tests fast and deterministic
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker",
                2,                      // failureThreshold
                2,                      // successThreshold
                Duration.ofMillis(200), // timeout for OPEN -> HALF_OPEN
                Duration.ofMillis(100)  // halfOpenTimeout (not used directly in logic)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance with CLOSED initial state")
    void testConstructorInitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("Static create() should use default configuration and be CLOSED")
    void testStaticCreate() {
        CircuitBreaker<String> cb = CircuitBreaker.create("defaultBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 5, 5, Duration.ofSeconds(5));

        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("getOrCreate should create different instances for different names")
    void testGetOrCreateDifferentNames() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "breakerA", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "breakerB", 3, 2, Duration.ofSeconds(1));

        assertNotSame(cb1, cb2);
    }

    @Test
    @DisplayName("execute should run operation when CLOSED and record success")
    void testExecuteSuccessWhenClosed() {
        String result = circuitBreaker.execute(() -> "ok");

        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should propagate exception and record failure")
    void testExecuteFailureRecordsFailure() {
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                })
        );

        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("CLOSED -> OPEN after reaching failure threshold via execute")
    void testClosedToOpenAfterFailures() {
        // failureThreshold is 2
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure2");
                })
        );
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteWhenOpenThrowsCircuitBreakerOpenException() {
        // Trip the breaker to OPEN
        testClosedToOpenAfterFailures();

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "should not run")
        );
    }

    @Test
    @DisplayName("allowRequest should return true when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenBeforeTimeout() {
        // Trip to OPEN
        testClosedToOpenAfterFailures();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        boolean allowed = circuitBreaker.allowRequest();
        assertFalse(allowed);
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("OPEN -> HALF_OPEN after timeout, allowRequest returns true once")
    void testOpenToHalfOpenAfterTimeout() throws InterruptedException {
        // Trip to OPEN
        testClosedToOpenAfterFailures();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout (200ms) plus a small buffer
        Thread.sleep(250);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, successful calls reaching successThreshold reset to CLOSED")
    void testHalfOpenToClosedOnSuccesses() throws InterruptedException {
        // Trip to OPEN
        testClosedToOpenAfterFailures();

        // Wait for timeout to allow HALF_OPEN
        Thread.sleep(250);

        // First allowRequest should move to HALF_OPEN
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold is 2
        circuitBreaker.execute(() -> "success1");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.execute(() -> "success2");
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure moves breaker back to OPEN")
    void testHalfOpenToOpenOnFailure() throws InterruptedException {
        // Trip to OPEN
        testClosedToOpenAfterFailures();

        // Wait for timeout to allow HALF_OPEN
        Thread.sleep(250);

        // Move to HALF_OPEN
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // A failure in HALF_OPEN should move back to OPEN
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("half-open failure");
                })
        );

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessResetsFailureCountInClosed() {
        // Manually record failures without execute
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());

        // Ensure state is OPEN now
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Manually set state back to CLOSED for this test
        // (simulate a reset scenario)
        AtomicReference<CircuitBreaker.State> stateField =
                new AtomicReference<>(CircuitBreaker.State.CLOSED);
        // We cannot access internal state directly; instead, create a new breaker:
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker2",
                2,
                2,
                Duration.ofMillis(200),
                Duration.ofMillis(100)
        );

        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in CLOSED increments failure count and may open circuit")
    void testRecordFailureInClosed() {
        // New breaker to ensure CLOSED state
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker3",
                2,
                2,
                Duration.ofMillis(200),
                Duration.ofMillis(100)
        );

        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getState should reflect transitions after failures and successes")
    void testGetStateTransitions() throws InterruptedException {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        // Trip to OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and move to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Two successes should move to CLOSED
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount should return current failure count")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should return consistent snapshot of breaker state")
    void testGetMetricsBasicFields() {
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();

        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
        // lastFailureTime is initialized to Instant.MIN
        assertEquals(Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("getMetrics should reflect failures and OPEN state")
    void testGetMetricsAfterFailures() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // should open

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();

        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertEquals(2, metrics.failureCount());
        assertTrue(metrics.lastFailureTime().isAfter(Instant.MIN));
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should update metrics successCount on success")
    void testMetricsSuccessCount() {
        circuitBreaker.execute(() -> "one");
        circuitBreaker.execute(() -> "two");

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(0, metrics.failureCount());
        assertEquals(2, metrics.successCount());
    }

    @Test
    @DisplayName("CircuitBreakerOpenException should carry message")
    void testCircuitBreakerOpenExceptionMessage() {
        CircuitBreaker.CircuitBreakerOpenException ex =
                new CircuitBreaker.CircuitBreakerOpenException("breaker open");
        assertEquals("breaker open", ex.getMessage());
    }
}