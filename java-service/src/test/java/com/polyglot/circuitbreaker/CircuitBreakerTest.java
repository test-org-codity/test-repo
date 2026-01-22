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
        // Use small thresholds and timeouts to make tests fast and deterministic
        circuitBreaker = new CircuitBreaker<>(
                "testBreaker",
                2,                      // failureThreshold
                2,                      // successThreshold
                Duration.ofMillis(200), // timeout for OPEN -> HALF_OPEN
                Duration.ofMillis(100)  // halfOpenTimeout (not used in current implementation)
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
    @DisplayName("Static create() should create instance with default configuration")
    void testStaticCreate() {
        CircuitBreaker<String> cb = CircuitBreaker.create("defaultBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());
    }

    @Test
    @DisplayName("getOrCreate should create new instance when not present in registry")
    void testGetOrCreateCreatesNew() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "registryBreaker",
                3,
                2,
                Duration.ofSeconds(1)
        );
        assertNotNull(cb1);
        assertEquals(CircuitBreaker.State.CLOSED, cb1.getState());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "sharedBreaker",
                3,
                2,
                Duration.ofSeconds(1)
        );
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "sharedBreaker",
                5,
                5,
                Duration.ofSeconds(5)
        );
        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("execute should return result on success and keep state CLOSED")
    void testExecuteSuccessKeepsClosed() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should propagate exception and record failure")
    void testExecuteFailureRecordsFailure() {
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
    @DisplayName("execute should throw CircuitBreakerOpenException when circuit is OPEN and timeout not elapsed")
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

        // Immediately try again - should be blocked
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> "shouldNotRun")
        );
    }

    @Test
    @DisplayName("allowRequest should be true when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should be false when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenBeforeTimeout() {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // threshold 2 -> OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        boolean allowed = circuitBreaker.allowRequest();
        assertFalse(allowed);
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should transition from OPEN to HALF_OPEN after timeout")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout (200ms) plus a small buffer
        Thread.sleep(250);

        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN should close circuit after reaching success threshold")
    void testRecordSuccessClosesFromHalfOpen() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(250);
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
    @DisplayName("recordSuccess in CLOSED should reset failure count")
    void testRecordSuccessResetsFailureCountInClosed() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN should transition back to OPEN")
    void testRecordFailureFromHalfOpenGoesToOpen() throws InterruptedException {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now a failure in HALF_OPEN should go back to OPEN
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in CLOSED should open circuit after threshold")
    void testRecordFailureOpensFromClosed() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getState should reflect transitions from CLOSED to OPEN to HALF_OPEN to CLOSED")
    void testGetStateTransitions() throws InterruptedException {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        // To OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // To HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // To CLOSED via successes
        circuitBreaker.recordSuccess();
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
    void testGetMetricsBasic() {
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertEquals("testBreaker", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
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
    @DisplayName("execute should update metrics on success and failure")
    void testExecuteUpdatesMetrics() {
        // One failure
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("fail");
                })
        );

        // One success
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(0, metrics.failureCount()); // reset in CLOSED on success
        assertTrue(metrics.successCount() >= 0); // successCount is internal; just ensure accessible
    }

    @Test
    @DisplayName("execute should not run supplier when circuit is OPEN and timeout not elapsed")
    void testExecuteDoesNotRunWhenOpen() {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        AtomicBoolean executed = new AtomicBoolean(false);

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                circuitBreaker.execute(() -> {
                    executed.set(true);
                    return "shouldNotRun";
                })
        );

        assertFalse(executed.get());
    }

    @Test
    @DisplayName("CircuitBreakerOpenException should carry message")
    void testCircuitBreakerOpenExceptionMessage() {
        CircuitBreaker.CircuitBreakerOpenException ex =
                new CircuitBreaker.CircuitBreakerOpenException("test message");
        assertEquals("test message", ex.getMessage());
    }
}