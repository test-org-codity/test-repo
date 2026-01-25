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
    @DisplayName("Initial state is CLOSED and allowRequest returns true")
    void testInitialStateAndAllowRequest() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute returns operation result and resets failure count on success")
    void testExecute_Success() {
        // Induce a failure first to increase failure count
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("boom"); }));
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure increments count and opens on threshold")
    void testRecordFailure_OpensOnThreshold() {
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("fail-1"); }));
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertNull(circuitBreaker.getMetrics().openedAt());

        // Second failure should open
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("fail-2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("execute throws CircuitBreakerOpenException when OPEN and timeout not elapsed (operation not executed)")
    void testExecute_ThrowsWhenOpen() {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        java.util.concurrent.atomic.AtomicInteger called = new java.util.concurrent.atomic.AtomicInteger(0);
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> circuitBreaker.execute(() -> {
            called.incrementAndGet();
            return "shouldNotRun";
        }));
        assertEquals(0, called.get());
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("OPEN -> HALF_OPEN after timeout; allowRequest returns true")
    void testAllowRequest_AfterTimeoutMovesToHalfOpen() throws InterruptedException {
        // Open
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Before timeout: not allowed
        assertFalse(circuitBreaker.allowRequest());

        // After timeout: should move to HALF_OPEN and allow
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
    }

    @Test
    @DisplayName("HALF_OPEN: successes reach threshold then CLOSE and reset counts")
    void testHalfOpen_SuccessesCloseAndReset() throws InterruptedException {
        // Open
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // First successful trial: still HALF_OPEN (successThreshold = 2)
        assertEquals("ok1", circuitBreaker.execute(() -> "ok1"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getMetrics().successCount());

        // Second successful trial: transitions to CLOSED and resets counts
        assertEquals("ok2", circuitBreaker.execute(() -> "ok2"));
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getMetrics().failureCount());
        assertEquals(0, circuitBreaker.getMetrics().successCount());
        assertNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("HALF_OPEN: any failure re-opens and sets openedAt; blocks until timeout")
    void testHalfOpen_FailureReopensAndBlocks() throws InterruptedException {
        // Open
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Fail once in HALF_OPEN -> should reopen
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("trialFail"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertNotNull(circuitBreaker.getMetrics().openedAt());

        // Should be blocked again until next timeout
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("Metrics: lastFailureTime updates on failure; openedAt null while CLOSED")
    void testMetrics_LastFailureTimeAndOpenedAt() {
        CircuitBreaker.CircuitBreakerMetrics metricsInitial = circuitBreaker.getMetrics();
        assertNotNull(metricsInitial);
        assertEquals(java.time.Instant.MIN, metricsInitial.lastFailureTime());
        assertNull(metricsInitial.openedAt());

        // One failure below threshold
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("fail"); }));

        CircuitBreaker.CircuitBreakerMetrics metricsAfterFailure = circuitBreaker.getMetrics();
        assertTrue(metricsAfterFailure.lastFailureTime().isAfter(java.time.Instant.MIN));
        assertNull(metricsAfterFailure.openedAt()); // still CLOSED (below threshold)
    }

    @Test
    @DisplayName("Success count resets to 0 when re-entering HALF_OPEN after reopen")
    void testSuccessCountResetsWhenReenterHalfOpen() throws InterruptedException {
        // Open
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Move to HALF_OPEN and get one success
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals("ok", circuitBreaker.execute(() -> "ok"));
        assertEquals(1, circuitBreaker.getMetrics().successCount());

        // Now fail to reopen
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("trialFail"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        // successCount is not reset on reopen
        assertEquals(1, circuitBreaker.getMetrics().successCount());

        // Wait and re-enter HALF_OPEN: successCount should reset to 0
        Thread.sleep(150);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getMetrics().successCount());
    }

    @Test
    @DisplayName("Factory method create(name) returns CLOSED breaker")
    void testCreateFactoryMethod() {
        CircuitBreaker<String> cb = CircuitBreaker.create("default-" + System.nanoTime());
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name and different for different names")
    void testGetOrCreateRegistry() {
        String regName1 = "reg-" + System.nanoTime();
        CircuitBreaker<String> a1 = CircuitBreaker.getOrCreate(regName1, 3, 2, java.time.Duration.ofMillis(10));
        CircuitBreaker<String> a2 = CircuitBreaker.getOrCreate(regName1, 100, 100, java.time.Duration.ofSeconds(5)); // different config ignored
        assertSame(a1, a2);

        String regName2 = regName1 + "-other";
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(regName2, 3, 2, java.time.Duration.ofMillis(10));
        assertNotSame(a1, b);
    }
}