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
        circuitBreaker = new CircuitBreaker<>("test-cb", 2, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state and metrics should be clean")
    void testInitialStateAndMetrics() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertTrue(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertEquals("test-cb", m.name());
        assertEquals(CircuitBreaker.State.CLOSED, m.state());
        assertEquals(0, m.failureCount());
        assertEquals(0, m.successCount());
        assertEquals(java.time.Instant.MIN, m.lastFailureTime());
        assertNull(m.openedAt());
    }

    @Test
    @DisplayName("execute: successful supplier returns value and resets failures")
    void testExecute_SuccessfulSupplierReturnsValueAndResetsFailures() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute: failure rethrows and increments failure count")
    void testExecute_FailureRethrowsAndCounts() {
        assertThrows(IllegalStateException.class, () -> circuitBreaker.execute(() -> {
            throw new IllegalStateException("boom");
        }));
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, m.lastFailureTime());
    }

    @Test
    @DisplayName("recordFailure: opens breaker at threshold")
    void testRecordFailure_OpensOnThreshold() {
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotNull(m.openedAt());
        assertNotEquals(java.time.Instant.MIN, m.lastFailureTime());
        assertEquals(2, m.failureCount());
    }

    @Test
    @DisplayName("allowRequest: OPEN and not timed out -> false")
    void testAllowRequest_OpenNotReady_ReturnsFalse() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // now OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("allowRequest: transitions OPEN -> HALF_OPEN after timeout and allows")
    void testAllowRequest_OpenAfterTimeout_MovesToHalfOpenAndAllows() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        Thread.sleep(150); // > timeout (100ms)
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordSuccess in HALF_OPEN: closes after successThreshold")
    void testRecordSuccess_InHalfOpen_ClosesAfterSuccessThreshold() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN

        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest()); // moves to HALF_OPEN

        circuitBreaker.recordSuccess();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, m1.state());
        assertEquals(1, m1.successCount());

        circuitBreaker.recordSuccess(); // should close
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(0, m2.successCount()); // reset on close
        assertNull(m2.openedAt());
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN: reopens immediately")
    void testRecordFailure_InHalfOpen_ReopensImmediately() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN

        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest()); // HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        circuitBreaker.recordFailure(); // should reopen
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("execute while OPEN (before timeout) throws CircuitBreakerOpenException")
    void testExecute_WhileOpenBeforeTimeout_ThrowsCircuitBreakerOpenException() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> circuitBreaker.execute(() -> "won't run"));
    }

    @Test
    @DisplayName("getFailureCount reflects current consecutive failures")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("Metrics successCount increments in HALF_OPEN then resets on close")
    void testMetrics_SuccessCountInHalfOpenIncrementsThenResetsOnClose() throws InterruptedException {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN

        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest()); // HALF_OPEN

        circuitBreaker.recordSuccess();
        CircuitBreaker.CircuitBreakerMetrics m1 = circuitBreaker.getMetrics();
        assertEquals(1, m1.successCount());
        assertEquals(CircuitBreaker.State.HALF_OPEN, m1.state());

        circuitBreaker.recordSuccess(); // close
        CircuitBreaker.CircuitBreakerMetrics m2 = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, m2.state());
        assertEquals(0, m2.successCount());
    }

    @Test
    @DisplayName("getOrCreate registry returns same instance for same name")
    void testGetOrCreateRegistryReturnsSameInstance() {
        String name = "registry-cb-" + System.nanoTime();
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(name, 3, 2, java.time.Duration.ofMillis(200));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(name, 5, 5, java.time.Duration.ofSeconds(1)); // different params should be ignored for existing
        assertSame(a, b);
    }

    @Test
    @DisplayName("create factory uses default failure threshold of 5 to open")
    void testCreateFactory_DefaultFailureThresholdFive() {
        String name = "default-cb-" + System.nanoTime();
        CircuitBreaker<String> cb = CircuitBreaker.create(name);

        // 4 failures should still be CLOSED
        for (int i = 0; i < 4; i++) {
            cb.recordFailure();
            assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        }

        // 5th failure opens
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertNotNull(cb.getMetrics().openedAt());
    }
}