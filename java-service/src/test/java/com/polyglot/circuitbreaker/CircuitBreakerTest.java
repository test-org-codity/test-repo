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
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker",
                3,                      // failureThreshold
                2,                      // successThreshold
                Duration.ofMillis(200), // timeout
                Duration.ofMillis(100)  // halfOpenTimeout (not used in logic directly)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("Static create() should use default configuration")
    void testStaticCreate() {
        CircuitBreaker<String> cb = CircuitBreaker.create("defaultBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
    }

    @Test
    @DisplayName("getOrCreate should create new instance when not present")
    void testGetOrCreateCreatesNew() {
        CircuitBreaker<String> cb = CircuitBreaker.getOrCreate(
                "registryBreaker",
                4,
                2,
                Duration.ofSeconds(1)
        );
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "sharedBreaker",
                4,
                2,
                Duration.ofSeconds(1)
        );
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "sharedBreaker",
                10, // different values should be ignored for existing
                5,
                Duration.ofSeconds(5)
        );
        assertSame(cb1, cb2);
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
    @DisplayName("execute should record failure and rethrow exception")
    void testExecuteFailureRecordsFailureAndRethrows() {
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
    void testExecuteOpensAfterFailureThreshold() {
        // failureThreshold is 3
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure " + i);
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(3, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpen() {
        // Open the circuit
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure " + i);
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
    @DisplayName("allowRequest should return true when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenBeforeTimeout() {
        // Open the circuit
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should transition to HALF_OPEN after timeout elapsed")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws InterruptedException {
        // Open the circuit
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse (timeout is 200ms)
        Thread.sleep(250);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN should close circuit after reaching success threshold")
    void testRecordSuccessClosesFromHalfOpen() {
        // Force state to HALF_OPEN
        AtomicReference<CircuitBreaker.State> stateRef =
                new AtomicReference<>(CircuitBreaker.State.HALF_OPEN);
        // Use reflection-like behavior via metrics/state methods is not possible,
        // but we can simulate by directly calling recordSuccess while in HALF_OPEN
        // However, state is private; we rely on allowRequest transition:
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Simulate timeout elapsed by manually setting openedAt via metrics is not possible,
        // so we instead wait for real time
        try {
            Thread.sleep(250);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        // First call to allowRequest moves to HALF_OPEN
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold is 2
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN should transition back to OPEN")
    void testRecordFailureFromHalfOpenGoesBackToOpen() throws InterruptedException {
        // Open the circuit
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse
        Thread.sleep(250);

        // Move to HALF_OPEN
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now record a failure in HALF_OPEN
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessResetsFailureCountInClosed() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure should increment failure count and open at threshold")
    void testRecordFailureIncrementsAndOpens() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(3, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getState should reflect current circuit state")
    void testGetState() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount should return current failure count")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should return consistent snapshot of breaker state")
    void testGetMetrics() {
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();

        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(circuitBreaker.getState(), metrics.state());
        assertEquals(circuitBreaker.getFailureCount(), metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("getMetrics openedAt should be null when never opened")
    void testGetMetricsOpenedAtNullWhenNeverOpened() {
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNull(metrics.openedAt());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
    }

    @Test
    @DisplayName("getMetrics openedAt should be set when circuit is OPEN")
    void testGetMetricsOpenedAtWhenOpen() {
        for (int i = 0; i < 3; i++) {
            circuitBreaker.recordFailure();
        }
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("CircuitBreakerOpenException should carry message")
    void testCircuitBreakerOpenExceptionMessage() {
        CircuitBreaker.CircuitBreakerOpenException ex =
                new CircuitBreaker.CircuitBreakerOpenException("breaker open");
        assertEquals("breaker open", ex.getMessage());
    }

    @Test
    @DisplayName("execute should allow successful call after HALF_OPEN success threshold")
    void testExecuteFlowClosedToOpenToHalfOpenToClosed() throws InterruptedException {
        // Move to OPEN
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout
        Thread.sleep(250);

        // First allowed call moves to HALF_OPEN and succeeds
        String r1 = circuitBreaker.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Second success should close the circuit (successThreshold = 2)
        String r2 = circuitBreaker.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute in HALF_OPEN should reopen on failure")
    void testExecuteFailureInHalfOpenReopens() throws InterruptedException {
        // Move to OPEN
        for (int i = 0; i < 3; i++) {
            try {
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail");
                });
            } catch (RuntimeException ignored) {
            }
        }
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout
        Thread.sleep(250);

        // Move to HALF_OPEN via allowRequest/execute
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now execute a failing operation
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("half-open fail");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }
}