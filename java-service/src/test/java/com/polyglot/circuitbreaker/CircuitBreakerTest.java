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
    private String name;

    @BeforeEach
    void setUp() {
        name = "cb-" + System.nanoTime();
        circuitBreaker = new CircuitBreaker<>(name, 2, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state is CLOSED and metrics reflect defaults")
    void testInitialStateAndMetrics() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotNull(m);
        assertEquals(name, m.name());
        assertEquals(CircuitBreaker.State.CLOSED, m.state());
        assertEquals(0, m.failureCount());
        assertEquals(0, m.successCount());
        assertEquals(java.time.Instant.MIN, m.lastFailureTime());
        assertNull(m.openedAt());
    }

    @Test
    @DisplayName("execute success returns value and resets failure count in CLOSED")
    void testExecuteSuccessResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "OK");
        assertEquals("OK", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute failure increments failure count and rethrows")
    void testExecuteFailureIncrementsCountAndRethrows() {
        int before = circuitBreaker.getFailureCount();
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            circuitBreaker.execute(() -> {
                throw new RuntimeException("boom");
            });
        });
        assertEquals("boom", ex.getMessage());
        assertEquals(before + 1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, m.lastFailureTime());
    }

    @Test
    @DisplayName("Breaker opens after reaching failure threshold in CLOSED")
    void testOpenAfterFailureThreshold() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // threshold is 2
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotNull(m.openedAt());
        assertEquals(2, m.failureCount());
    }

    @Test
    @DisplayName("execute throws CircuitBreakerOpenException when OPEN before timeout")
    void testExecuteWhenOpenThrows() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // now OPEN
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> {
            circuitBreaker.execute(() -> "should not run");
        });
    }

    @Test
    @DisplayName("allowRequest transitions OPEN -> HALF_OPEN after timeout elapses")
    void testTransitionToHalfOpenAfterTimeoutInAllowRequest() throws Exception {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // OPEN
        assertFalse(circuitBreaker.allowRequest());

        Thread.sleep(150); // wait beyond 100ms timeout
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Successes in HALF_OPEN reaching threshold close the breaker and reset metrics")
    void testHalfOpenSuccessesCloseBreaker() throws Exception {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN after timeout
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Two successes (successThreshold = 2) should close the breaker
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState()); // still half-open after first success
        circuitBreaker.recordSuccess();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertEquals(0, m.failureCount());
        assertEquals(0, m.successCount());
        assertNull(m.openedAt());
    }

    @Test
    @DisplayName("Failure in HALF_OPEN reopens the breaker and sets openedAt")
    void testHalfOpenFailureReopens() throws Exception {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // A failure in HALF_OPEN should reopen
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotNull(m.openedAt());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for the same name")
    void testGetOrCreateSameInstance() {
        String regName = "registry-" + System.nanoTime();
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(regName, 1, 1, java.time.Duration.ofMillis(100));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(regName, 5, 3, java.time.Duration.ofSeconds(1));
        assertSame(cb1, cb2);
    }

    @Test
    @DisplayName("create(String) returns CLOSED breaker that allows requests")
    void testCreateDefaultBreaker() {
        CircuitBreaker<String> defaultCb = CircuitBreaker.create("default-" + System.nanoTime());
        assertEquals(CircuitBreaker.State.CLOSED, defaultCb.getState());
        assertTrue(defaultCb.allowRequest());
        assertEquals(0, defaultCb.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics m = defaultCb.getMetrics();
        assertEquals(java.time.Instant.MIN, m.lastFailureTime());
        assertNull(m.openedAt());
    }
}