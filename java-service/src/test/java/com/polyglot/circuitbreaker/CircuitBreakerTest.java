package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;

    @BeforeEach
    void setUp() {
        // Small thresholds and short timeout to keep tests fast and deterministic
        circuitBreaker = new CircuitBreaker<>("testCB", 2, 2, Duration.ofMillis(200), Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state should be CLOSED and allow requests")
    void testInitialStateAndAllowRequest() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("recordFailure increments failure count and opens at threshold")
    void testRecordFailureTransitionsToOpenAtThreshold() {
        // First failure in CLOSED increases count, remains CLOSED
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics metrics1 = circuitBreaker.getMetrics();
        assertNotEquals(Instant.MIN, metrics1.lastFailureTime());
        assertNull(metrics1.openedAt());

        // Second failure reaches threshold and transitions to OPEN
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics metrics2 = circuitBreaker.getMetrics();
        assertNotNull(metrics2.openedAt());
        assertFalse(circuitBreaker.allowRequest()); // immediate deny while OPEN before timeout
    }

    @Test
    @DisplayName("execute should record success and keep CLOSED; failure count resets to 0")
    void testExecuteSuccessResetsFailureCount() {
        // Start with one failure
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        // Success in CLOSED resets failure count
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failure count")
    void testRecordSuccessInClosedResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and supplier should not run")
    void testExecuteThrowsWhenOpen() {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        AtomicInteger callCount = new AtomicInteger(0);
        CircuitBreaker.CircuitBreakerOpenException ex = assertThrows(
                CircuitBreaker.CircuitBreakerOpenException.class,
                () -> circuitBreaker.execute(() -> {
                    callCount.incrementAndGet();
                    return "should not run";
                })
        );
        assertTrue(ex.getMessage().contains("testCB"));
        assertEquals(0, callCount.get());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should remain false while OPEN before timeout, then true after timeout (transition to HALF_OPEN)")
    void testAllowRequestBehaviorAroundTimeout() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        // Sleep less than timeout: still false
        Thread.sleep(100);
        assertFalse(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Sleep past timeout: allowRequest should change state to HALF_OPEN and return true
        Thread.sleep(150);
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("OPEN -> HALF_OPEN after timeout; then enough successes -> CLOSED (counters reset)")
    void testHalfOpenSuccessesCloseBreaker() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait until timeout to transition on next allow/execute
        Thread.sleep(250);

        // First success in HALF_OPEN
        String r1 = circuitBreaker.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Second success meets successThreshold -> CLOSED and reset counters
        String r2 = circuitBreaker.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        // After reset, successCount should be 0 and openedAt should be null
        assertEquals(0, metrics.successCount());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure should reopen the circuit and set openedAt")
    void testHalfOpenFailureReopensBreaker() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait to allow HALF_OPEN probe through execute
        Thread.sleep(250);

        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("probe failure");
                })
        );
        assertEquals("probe failure", ex.getMessage());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("getOrCreate should return the same instance for the same name and different for different names")
    void testGetOrCreateRegistryBehavior() {
        CircuitBreaker<String> a1 = CircuitBreaker.getOrCreate("registryCB1", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<Integer> a2 = CircuitBreaker.getOrCreate("registryCB1", 5, 3, Duration.ofSeconds(2));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate("registryCB2", 3, 2, Duration.ofSeconds(1));

        assertSame(a1, a2);
        assertNotSame(a1, b);
    }

    @Test
    @DisplayName("create(name) uses defaults; should open after 5 failures")
    void testCreateDefaultFactory() {
        CircuitBreaker<String> def = CircuitBreaker.create("defaultCB");
        assertEquals(CircuitBreaker.State.CLOSED, def.getState());
        assertTrue(def.allowRequest());

        // Default failureThreshold is 5 per implementation
        def.recordFailure();
        def.recordFailure();
        def.recordFailure();
        def.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, def.getState());
        def.recordFailure(); // 5th failure reaches threshold
        assertEquals(CircuitBreaker.State.OPEN, def.getState());
    }

    @Test
    @DisplayName("execute should propagate runtime exceptions and record failure")
    void testExecuteFailurePropagationAndCounting() {
        assertEquals(0, circuitBreaker.getFailureCount());

        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("boom");
                })
        );
        assertEquals("boom", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Metrics should reflect lastFailureTime and openedAt transitions")
    void testMetricsReflectStateAndTimestamps() {
        // Initially
        CircuitBreaker.CircuitBreakerMetrics m0 = circuitBreaker.getMetrics();
        assertEquals(Instant.MIN, m0.lastFailureTime());
        assertNull(m0.openedAt());

        // One failure
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertNotEquals(Instant.MIN, m1.lastFailureTime());
        assertNull(m1.openedAt());
        assertEquals(1, m1.failureCount());

        // Second failure -> OPEN
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m2.state());
        assertNotNull(m2.openedAt());
        assertEquals(2, m2.failureCount());
    }

    @Test
    @DisplayName("Failure threshold of 1 should open after a single failure")
    void testFailureThresholdOneOpensImmediately() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("ft1", 1, 2, Duration.ofMillis(100), Duration.ofMillis(50));
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());
    }
}