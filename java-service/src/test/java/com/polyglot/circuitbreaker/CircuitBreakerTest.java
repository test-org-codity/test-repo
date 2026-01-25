package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;

    @BeforeEach
    void setUp() {
        // Use small thresholds/timeouts to make tests fast and deterministic
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
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 5, 5, Duration.ofSeconds(5));

        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("getOrCreate should return different instances for different names")
    void testGetOrCreateDifferentNames() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "breakerA", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "breakerB", 3, 2, Duration.ofSeconds(1));

        assertNotSame(cb1, cb2);
    }

    @Test
    @DisplayName("execute should run operation and record success in CLOSED state")
    void testExecuteSuccessInClosed() {
        String result = circuitBreaker.execute(() -> "ok");

        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should record failure and rethrow exception")
    void testExecuteFailureInClosed() {
        RuntimeException ex = new RuntimeException("failure");

        RuntimeException thrown = assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw ex;
                })
        );

        assertSame(ex, thrown);
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should open circuit after reaching failure threshold")
    void testExecuteOpensAfterFailures() {
        // failureThreshold is 2
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail1");
                })
        );
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail2");
                })
        );
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpen() {
        // Open the circuit
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail1");
                })
        );
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail2");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "shouldNotRun")
        );
    }

    @Test
    @DisplayName("allowRequest should be true in CLOSED state")
    void testAllowRequestClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should be false in OPEN state before timeout")
    void testAllowRequestOpenBeforeTimeout() {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // reaches threshold -> OPEN

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should transition OPEN -> HALF_OPEN after timeout and allow request")
    void testAllowRequestOpenAfterTimeout() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout (200ms) plus small buffer
        Thread.sleep(250);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should be true in HALF_OPEN state")
    void testAllowRequestHalfOpen() {
        // Force state to HALF_OPEN by opening then simulating timeout via allowRequest
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Manually simulate timeout by setting openedAt in the past via metrics
        CircuitBreaker.CircuitBreakerMetrics metricsBefore = circuitBreaker.getMetrics();
        assertNotNull(metricsBefore.openedAt());

        // Wait enough for timeout to pass
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
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessInClosedResetsFailures() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN should close circuit after reaching success threshold")
    void testRecordSuccessInHalfOpenClosesCircuit() {
        // Open circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Simulate timeout and transition to HALF_OPEN
        try {
            Thread.sleep(250);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
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
    void testRecordFailureInHalfOpenOpensCircuit() {
        // Open circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Simulate timeout and transition to HALF_OPEN
        try {
            Thread.sleep(250);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now a failure in HALF_OPEN should go back to OPEN
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in CLOSED should increment failure count and open at threshold")
    void testRecordFailureInClosedIncrementsAndOpens() {
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
    @DisplayName("getState should reflect current circuit state")
    void testGetState() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount should return current failure count")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("getMetrics should return consistent snapshot of breaker state")
    void testGetMetricsBasic() {
        circuitBreaker.recordFailure();

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(1, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertNotNull(metrics.lastFailureTime());
    }

    @Test
    @DisplayName("getMetrics should reflect OPEN state and openedAt timestamp")
    void testGetMetricsOpenState() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertEquals(2, metrics.failureCount());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute should increment successCount in HALF_OPEN and close after threshold")
    void testExecuteSuccessFlowInHalfOpen() throws InterruptedException {
        // Open circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and transition to HALF_OPEN via allowRequest
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold is 2
        String r1 = circuitBreaker.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        String r2 = circuitBreaker.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should transition HALF_OPEN back to OPEN on failure")
    void testExecuteFailureInHalfOpen() throws InterruptedException {
        // Open circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and transition to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("half-open failure");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute should not invoke supplier when circuit is OPEN and timeout not elapsed")
    void testExecuteDoesNotInvokeSupplierWhenOpen() {
        // Open circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        AtomicBoolean called = new AtomicBoolean(false);

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> {
                    called.set(true);
                    return "shouldNotRun";
                })
        );

        assertFalse(called.get());
    }

    @Test
    @DisplayName("recordFailure should update lastFailureTime")
    void testRecordFailureUpdatesLastFailureTime() {
        CircuitBreaker.CircuitBreakerMetrics before = circuitBreaker.getMetrics();
        Instant beforeTime = before.lastFailureTime();

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics after = circuitBreaker.getMetrics();
        Instant afterTime = after.lastFailureTime();

        assertNotNull(afterTime);
        if (beforeTime != null && !beforeTime.equals(Instant.MIN)) {
            assertTrue(afterTime.equals(beforeTime) || afterTime.isAfter(beforeTime));
        }
    }
}