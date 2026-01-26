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
        // Use small thresholds and timeouts to make behavior easy to test
        circuitBreaker = new CircuitBreaker<>("testBreaker", 2, 2,
                java.time.Duration.ofMillis(200),
                java.time.Duration.ofMillis(100));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance with CLOSED state")
    void testConstructorAndInitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("Static create() should use default configuration and start CLOSED")
    void testStaticCreate() {
        CircuitBreaker<String> cb = CircuitBreaker.create("defaultBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
    }

    @Test
    @DisplayName("getOrCreate should create new instance when none registered")
    void testGetOrCreateCreatesNew() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registryBreaker1", 3, 2, java.time.Duration.ofSeconds(1));
        assertNotNull(cb1);
        assertEquals(CircuitBreaker.State.CLOSED, cb1.getState());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSame() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registryBreaker2", 3, 2, java.time.Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "registryBreaker2", 5, 5, java.time.Duration.ofSeconds(2));

        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("execute should return operation result on success")
    void testExecuteSuccess() {
        String result = circuitBreaker.execute(() -> "OK");
        assertEquals("OK", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should propagate exception and record failure")
    void testExecuteFailure() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                })
        );
        assertEquals("failure", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should open circuit after reaching failure threshold")
    void testExecuteOpensCircuitAfterThreshold() {
        // Threshold is 2
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
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpen() {
        // Open the circuit
        for (int i = 0; i < 2; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "should not run")
        );
    }

    @Test
    @DisplayName("allowRequest should move from OPEN to HALF_OPEN after timeout")
    void testAllowRequestTransitionOpenToHalfOpen() throws InterruptedException {
        // Open the circuit
        for (int i = 0; i < 2; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        // Wait for timeout to elapse
        Thread.sleep(250); // slightly more than 200ms timeout

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, consecutive successes should close circuit after success threshold")
    void testHalfOpenSuccessClosesCircuit() throws InterruptedException {
        // Open the circuit
        for (int i = 0; i < 2; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait enough for reset attempt
        Thread.sleep(250);

        // First allowed request moves to HALF_OPEN
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold = 2
        circuitBreaker.recordSuccess(); // first success
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess(); // second success should close
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure should reopen the circuit")
    void testHalfOpenFailureReopensCircuit() throws InterruptedException {
        // Open the circuit
        for (int i = 0; i < 2; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(250);

        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessInClosedResetsFailures() {
        // Cause one failure
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        // Success in CLOSED should reset failureCount to 0
        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in CLOSED should open after reaching threshold")
    void testRecordFailureOpensAfterThreshold() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should always allow when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should deny when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenAndTimeoutNotElapsed() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should allow when HALF_OPEN")
    void testAllowRequestWhenHalfOpen() {
        // Force state to HALF_OPEN via reflection of behavior: open then allow after timeout
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Manually mimic timeout elapsed by sleeping
        try {
            Thread.sleep(250);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("getState should return current state")
    void testGetState() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount should return correct value")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should reflect current state and counters")
    void testGetMetrics() {
        CircuitBreaker.CircuitBreakerMetrics metricsBefore = circuitBreaker.getMetrics();
        assertNotNull(metricsBefore);
        assertEquals("testBreaker", metricsBefore.name());
        assertEquals(CircuitBreaker.State.CLOSED, metricsBefore.state());
        assertEquals(0, metricsBefore.failureCount());
        assertEquals(0, metricsBefore.successCount());
        assertNotNull(metricsBefore.lastFailureTime());
        // lastFailureTime is Instant.MIN initially, openedAt is null
        assertEquals(java.time.Instant.MIN, metricsBefore.lastFailureTime());
        assertNull(metricsBefore.openedAt());

        // Cause failure to update metrics
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics metricsAfter = circuitBreaker.getMetrics();
        assertEquals(1, metricsAfter.failureCount());
        assertNotEquals(java.time.Instant.MIN, metricsAfter.lastFailureTime());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and allowRequest is false")
    void testExecuteWhenOpenThrowsCircuitBreakerOpenException() {
        // Open the circuit via recordFailure
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // now OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "should not execute")
        );
    }

    @Test
    @DisplayName("Metrics openedAt should be set when circuit opens")
    void testMetricsOpenedAtWhenOpen() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }
}