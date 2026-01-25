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
    private String cbName;
    private static final int FAILURE_THRESHOLD = 2;
    private static final int SUCCESS_THRESHOLD = 2;
    private static final long TIMEOUT_MS = 150L;
    private static final long HALF_OPEN_TIMEOUT_MS = 50L;

    @BeforeEach
    void setUp() {
        cbName = "cb-" + System.nanoTime();
        circuitBreaker = new CircuitBreaker<>(
                cbName,
                FAILURE_THRESHOLD,
                SUCCESS_THRESHOLD,
                java.time.Duration.ofMillis(TIMEOUT_MS),
                java.time.Duration.ofMillis(HALF_OPEN_TIMEOUT_MS)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state is CLOSED and allowRequest() returns true")
    void testInitialStateAndAllowRequest() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute() returns supplier result in CLOSED state")
    void testExecuteSuccessInClosed() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordFailure increments count and opens when threshold reached")
    void testRecordFailureAndOpenOnThreshold() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertTrue(circuitBreaker.getFailureCount() >= FAILURE_THRESHOLD);

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt());
        assertEquals(cbName, metrics.name());
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
    }

    @Test
    @DisplayName("execute() throws CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpenBeforeTimeout() {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "should not run"));
    }

    @Test
    @DisplayName("allowRequest() transitions OPEN -> HALF_OPEN after timeout")
    void testAllowRequestAfterTimeoutMovesToHalfOpen() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse
        Thread.sleep(TIMEOUT_MS + 75);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(0, metrics.successCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, success below threshold keeps HALF_OPEN; reaching threshold closes")
    void testHalfOpenSuccessesCloseOnThreshold() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and move to HALF_OPEN
        Thread.sleep(TIMEOUT_MS + 75);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // First success: should remain HALF_OPEN
        String r1 = circuitBreaker.execute(() -> "one");
        assertEquals("one", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(1, circuitBreaker.getMetrics().successCount());

        // Second success: should transition to CLOSED and reset counts
        String r2 = circuitBreaker.execute(() -> "two");
        assertEquals("two", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(0, circuitBreaker.getMetrics().successCount());
        assertNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure transitions back to OPEN")
    void testHalfOpenFailureReopens() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and move to HALF_OPEN
        Thread.sleep(TIMEOUT_MS + 75);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Fail the trial
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("trial fail");
        }));

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failureCount")
    void testRecordSuccessResetsFailureCountWhenClosed() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getMetrics reflects name, state, counts, and timestamps")
    void testMetrics() {
        // Initial metrics
        CircuitBreaker.CircuitBreakerMetrics m0 = circuitBreaker.getMetrics();
        assertEquals(cbName, m0.name());
        assertEquals(CircuitBreaker.State.CLOSED, m0.state());
        assertEquals(0, m0.failureCount());
        assertEquals(0, m0.successCount());
        assertEquals(java.time.Instant.MIN, m0.lastFailureTime());
        assertNull(m0.openedAt());

        // After one failure
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(1, m1.failureCount());
        assertNotEquals(java.time.Instant.MIN, m1.lastFailureTime());
        assertNull(m1.openedAt());

        // Open it
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m2.state());
        assertNotNull(m2.openedAt());
    }

    @Test
    @DisplayName("Static create() uses defaults and opens after 5 failures")
    void testStaticCreateDefaults() {
        String name = "default-" + System.nanoTime();
        CircuitBreaker<String> cb = CircuitBreaker.create(name);

        // 4 failures: still CLOSED
        for (int i = 0; i < 4; i++) {
            cb.recordFailure();
            assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        }
        // 5th failure opens
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name and preserves original thresholds")
    void testGetOrCreateRegistrySingletonAndThresholds() {
        String name = "registry-" + System.nanoTime();
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(name, 3, 2, java.time.Duration.ofMillis(200));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(name, 1, 1, java.time.Duration.ofMillis(10));

        assertSame(a, b);

        // Original threshold was 3; after 2 failures it should still be CLOSED
        a.recordFailure();
        a.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, a.getState());

        // Third failure should open it
        a.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, a.getState());
    }

    @Test
    @DisplayName("execute propagates original runtime exception and records failure")
    void testExecutePropagatesExceptionAndCounts() {
        assertThrows(IllegalStateException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new IllegalStateException("boom");
                })
        );
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }
}
