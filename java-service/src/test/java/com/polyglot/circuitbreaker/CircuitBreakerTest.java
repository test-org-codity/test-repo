package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.time.Instant;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> breaker;

    @BeforeEach
    void setUp() {
        breaker = new CircuitBreaker<>("test-breaker", 3, 2, Duration.ofMillis(100), Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        breaker = null;
    }

    @Test
    @DisplayName("Initial state is CLOSED and requests are allowed")
    void testInitialStateAndAllowRequest() {
        assertNotNull(breaker);
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
        assertTrue(breaker.allowRequest());
        assertEquals(0, breaker.getFailureCount());
    }

    @Test
    @DisplayName("execute returns result and records success")
    void testExecuteSuccessRecordsSuccess() {
        // Prime with a failure count and then ensure success resets it
        breaker.recordFailure();
        assertEquals(1, breaker.getFailureCount());

        String result = breaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, breaker.getFailureCount(), "Success in CLOSED should reset failure count to 0");
    }

    @Test
    @DisplayName("execute propagates exception and records failure")
    void testExecuteFailureRecordsFailureAndPropagates() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            breaker.execute(() -> {
                throw new RuntimeException("boom");
            });
        });
        assertEquals("boom", ex.getMessage());
        assertEquals(1, breaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
        assertNotEquals(Instant.MIN, breaker.getMetrics().lastFailureTime());
        assertNull(breaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("Transitions to OPEN after reaching failure threshold")
    void testTransitionToOpenAfterFailures() {
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure(); // Threshold is 3
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
        assertEquals(3, breaker.getFailureCount());
        assertNotNull(breaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("OPEN state blocks requests until timeout")
    void testOpenBlocksRequestsUntilTimeout() {
        // Move to OPEN
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());

        // Immediately after opening, requests should be blocked
        assertFalse(breaker.allowRequest());

        // execute should throw CircuitBreakerOpenException while still OPEN and not timed out
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> {
            breaker.execute(() -> "should-not-run");
        });
    }

    @Test
    @DisplayName("After timeout, allowRequest transitions OPEN -> HALF_OPEN and allows a call")
    void testAllowRequestTransitionsToHalfOpenAfterTimeout() throws Exception {
        // Open breaker
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());

        // Wait past timeout
        Thread.sleep(120);
        boolean allowed = breaker.allowRequest();
        assertTrue(allowed, "Request should be allowed after timeout");
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());
        assertEquals(0, breaker.getMetrics().successCount(), "Success count should be reset when entering HALF_OPEN");

        // Further allowRequest in HALF_OPEN should still allow
        assertTrue(breaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, enough successes transition back to CLOSED and reset metrics")
    void testHalfOpenSuccessesTransitionToClosedAndReset() throws Exception {
        // Move to OPEN
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure();

        // Wait and transition to HALF_OPEN
        Thread.sleep(120);
        assertTrue(breaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());

        // First success - remain HALF_OPEN
        breaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());
        assertEquals(1, breaker.getMetrics().successCount());

        // Second success - should CLOSE and reset
        breaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
        assertEquals(0, breaker.getFailureCount());
        assertEquals(0, breaker.getMetrics().successCount());
        assertNull(breaker.getMetrics().openedAt(), "openedAt should be cleared when reset to CLOSED");
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure transitions back to OPEN")
    void testHalfOpenFailureTransitionsBackToOpen() throws Exception {
        // Open breaker
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure();

        // Move to HALF_OPEN after timeout
        Thread.sleep(120);
        assertTrue(breaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, breaker.getState());

        // A failure in HALF_OPEN re-opens the circuit
        breaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
        assertNotNull(breaker.getMetrics().openedAt());
        assertFalse(breaker.allowRequest(), "Should remain blocked until timeout again");
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failure count")
    void testRecordSuccessResetsFailureCountInClosed() {
        breaker.recordFailure();
        breaker.recordFailure();
        assertEquals(2, breaker.getFailureCount());

        breaker.recordSuccess();
        assertEquals(0, breaker.getFailureCount(), "Success in CLOSED should reset failure count");
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
    }

    @Test
    @DisplayName("getMetrics reflects current state and counts")
    void testGetMetricsReflectsStateAndCounts() {
        CircuitBreaker.CircuitBreakerMetrics m1 = breaker.getMetrics();
        assertEquals("test-breaker", m1.name());
        assertEquals(CircuitBreaker.State.CLOSED, m1.state());
        assertEquals(0, m1.failureCount());
        assertEquals(0, m1.successCount());
        assertEquals(Instant.MIN, m1.lastFailureTime());
        assertNull(m1.openedAt());

        breaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m2 = breaker.getMetrics();
        assertEquals(1, m2.failureCount());
        assertEquals(CircuitBreaker.State.CLOSED, m2.state());
        assertNotEquals(Instant.MIN, m2.lastFailureTime());
        assertNull(m2.openedAt());

        // Open it
        breaker.recordFailure();
        breaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics m3 = breaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, m3.state());
        assertNotNull(m3.openedAt());
    }

    @Test
    @DisplayName("create(name) uses defaults and opens after five failures")
    void testCreateWithDefaultsOpensAfterFiveFailures() {
        CircuitBreaker<Integer> cb = CircuitBreaker.create("default-breaker-" + System.nanoTime());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure(); // Default failure threshold is 5
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertEquals(5, cb.getFailureCount());
        assertNotNull(cb.getMetrics().openedAt());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name and respects initial config")
    void testGetOrCreateReturnsSameInstanceForSameName() {
        String name = "registry-" + System.nanoTime();

        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(name, 2, 1, Duration.ofMillis(10));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(name, 5, 3, Duration.ofSeconds(1)); // Should return same instance as 'a'

        assertSame(a, b, "getOrCreate should return the same instance for the same name");

        // Because the breaker was created with failureThreshold=2, two failures should open it
        a.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, a.getState());
        a.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, a.getState());
    }

    @Test
    @DisplayName("Metrics lastFailureTime and openedAt set appropriately when opening")
    void testMetricsOpenedAtAndLastFailureTimeSetOnOpen() {
        assertEquals(Instant.MIN, breaker.getMetrics().lastFailureTime());
        assertNull(breaker.getMetrics().openedAt());

        breaker.recordFailure();
        assertNotEquals(Instant.MIN, breaker.getMetrics().lastFailureTime());
        assertNull(breaker.getMetrics().openedAt(), "openedAt should still be null while CLOSED");

        breaker.recordFailure();
        breaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, breaker.getState());
        assertNotNull(breaker.getMetrics().openedAt(), "openedAt should be set when state is OPEN");
    }
}