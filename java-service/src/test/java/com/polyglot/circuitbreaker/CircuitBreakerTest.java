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
                2,                    // failureThreshold
                2,                    // successThreshold
                Duration.ofMillis(200), // timeout
                Duration.ofMillis(100)  // halfOpenTimeout (not used in logic yet)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor should create instance with CLOSED state")
    void testConstructorInitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should run operation when CLOSED and record success")
    void testExecuteSuccessInClosed() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute should record failure and rethrow exception")
    void testExecuteFailureInClosed() {
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
        // first failure
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        // second failure reaches threshold (2) and opens
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
    void testExecuteWhenOpenBeforeTimeout() {
        // Open the circuit
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure2");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerOpenException ex =
                assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
                        circuitBreaker.execute(() -> "shouldNotRun")
                );
        assertTrue(ex.getMessage().contains("Circuit breaker 'testBreaker' is open"));
    }

    @Test
    @DisplayName("allowRequest should transition from OPEN to HALF_OPEN after timeout")
    void testAllowRequestTransitionToHalfOpenAfterTimeout() throws InterruptedException {
        // Open the circuit
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure2");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Immediately after open, should not allow
        assertFalse(circuitBreaker.allowRequest());

        // Wait for timeout to elapse
        Thread.sleep(250);

        // Now allowRequest should move to HALF_OPEN and allow one request
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, enough successes should close the circuit and reset counts")
    void testHalfOpenSuccessesCloseCircuit() throws InterruptedException {
        // Open the circuit
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure2");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to move to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // successThreshold is 2, so two successes should close it
        circuitBreaker.execute(() -> "ok1");
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.execute(() -> "ok2");
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure should immediately reopen the circuit")
    void testHalfOpenFailureReopensCircuit() throws InterruptedException {
        // Open the circuit
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure1");
                })
        );
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("failure2");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to move to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now a failure in HALF_OPEN should move back to OPEN
        assertThrows(RuntimeException.class, () ->
                circuitBreaker.execute(() -> {
                    throw new RuntimeException("halfOpenFailure");
                })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("allowRequest should always return true when CLOSED")
    void testAllowRequestWhenClosed() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should return false when OPEN and timeout not elapsed")
    void testAllowRequestWhenOpenBeforeTimeout() {
        // Open the circuit
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // threshold 2
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest should return true when HALF_OPEN")
    void testAllowRequestWhenHalfOpen() {
        // Force state to HALF_OPEN via reflection-like direct state change is not possible,
        // so we simulate by opening then waiting for timeout and calling allowRequest once.
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Manually simulate timeout by setting openedAt in metrics via reflection-like approach
        // Not possible directly; instead, wait for real timeout
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
    void testRecordSuccessResetsFailuresInClosed() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN then CLOSED via successes
        try {
            Thread.sleep(250);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        circuitBreaker.recordSuccess(); // should close and reset
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        // Now another success in CLOSED should keep failureCount at 0
        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordFailure in CLOSED should increment failure count and open at threshold")
    void testRecordFailureInClosedOpensAtThreshold() {
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
    @DisplayName("recordFailure in HALF_OPEN should move to OPEN and set openedAt")
    void testRecordFailureInHalfOpen() throws InterruptedException {
        // Open
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(250);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now recordFailure should move to OPEN
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics.openedAt());
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
    @DisplayName("getMetrics should reflect openedAt when circuit is OPEN")
    void testGetMetricsOpenedAtWhenOpen() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // opens
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();

        assertEquals(CircuitBreaker.State.OPEN, metrics.state());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("create factory method should use default configuration and be CLOSED")
    void testCreateFactoryMethod() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factoryBreaker");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 3, 2, Duration.ofSeconds(1));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(
                "sharedBreaker", 5, 5, Duration.ofSeconds(5));

        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("CircuitBreakerOpenException should be a RuntimeException with message")
    void testCircuitBreakerOpenException() {
        CircuitBreaker.CircuitBreakerOpenException ex =
                new CircuitBreaker.CircuitBreakerOpenException("open");
        assertTrue(ex instanceof RuntimeException);
        assertEquals("open", ex.getMessage());
    }
}