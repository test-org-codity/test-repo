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
        circuitBreaker = new CircuitBreaker<>("test-cb", 3, 2, java.time.Duration.ofMillis(150), java.time.Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state is CLOSED and allowRequest returns true")
    void testInitialStateAndAllowRequest() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(0, circuitBreaker.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics m = circuitBreaker.getMetrics();
        assertNotNull(m);
        assertEquals("test-cb", m.name());
        assertEquals(CircuitBreaker.State.CLOSED, m.state());
        assertEquals(0, m.failureCount());
        assertEquals(0, m.successCount());
        assertNotNull(m.lastFailureTime());
    }

    @Test
    @DisplayName("execute returns result and resets failure count in CLOSED state")
    void testExecuteSuccessResetsFailureCount() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("execute propagates exception, records failures, opens after threshold, and denies while OPEN")
    void testExecuteThrowRecordsFailureAndOpensAndOpenDenies() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("open-deny", 2, 2, java.time.Duration.ofSeconds(5), java.time.Duration.ofSeconds(1));

        RuntimeException ex1 = assertThrows(RuntimeException.class, () -> cb.execute(() -> { throw new RuntimeException("boom1"); }));
        assertEquals("boom1", ex1.getMessage());
        assertEquals(1, cb.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        RuntimeException ex2 = assertThrows(RuntimeException.class, () -> cb.execute(() -> { throw new RuntimeException("boom2"); }));
        assertEquals("boom2", ex2.getMessage());
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertNotNull(metrics.openedAt());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> "will-not-run"));
        assertFalse(cb.allowRequest());
    }

    @Test
    @DisplayName("allowRequest returns false when OPEN and timeout has not elapsed")
    void testAllowRequestOpenBeforeTimeoutFalse() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("open-before-timeout", 1, 1, java.time.Duration.ofSeconds(10), java.time.Duration.ofSeconds(1));
        cb.recordFailure(); // opens immediately
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());
    }

    @Test
    @DisplayName("OPEN transitions to HALF_OPEN after timeout; successes to threshold close breaker and reset state")
    void testOpenToHalfOpenAfterTimeoutThenCloseAfterSuccesses() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("half-open-close", 1, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(10));
        cb.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());

        Thread.sleep(130); // exceed timeout

        // First request allowed and moves to HALF_OPEN
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
        CircuitBreaker.CircuitBreakerMetrics m1 = cb.getMetrics();
        assertNotNull(m1.openedAt());

        // First success - remain HALF_OPEN
        String r1 = cb.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
        assertEquals(1, cb.getMetrics().successCount());

        // Second success - reach threshold -> CLOSED and reset
        String r2 = cb.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        CircuitBreaker.CircuitBreakerMetrics m2 = cb.getMetrics();
        assertEquals(0, m2.failureCount());
        assertEquals(0, m2.successCount());
        assertNull(m2.openedAt());
    }

    @Test
    @DisplayName("Failure during HALF_OPEN re-opens the breaker and starts timeout")
    void testHalfOpenFailureReopens() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("half-open-failure", 1, 2, java.time.Duration.ofMillis(80), java.time.Duration.ofMillis(10));
        cb.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(100); // exceed timeout

        RuntimeException ex = assertThrows(RuntimeException.class, () -> cb.execute(() -> { throw new RuntimeException("fail during half-open"); }));
        assertEquals("fail during half-open", ex.getMessage());

        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());
        assertNotNull(cb.getMetrics().openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failure count without changing state")
    void testRecordSuccessClosedResetsFailures() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount reflects recorded failures")
    void testGetFailureCount() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("Metrics reflect HALF_OPEN with one success and preserve failure count and openedAt")
    void testMetricsInHalfOpenAfterOneSuccess() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("metrics-half-open", 2, 3, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        cb.recordFailure(); // reaches threshold -> OPEN
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        int failuresAtOpen = cb.getFailureCount();
        assertEquals(2, failuresAtOpen);

        Thread.sleep(130);
        assertTrue(cb.allowRequest()); // move to HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        // One success in HALF_OPEN
        cb.execute(() -> "ok");
        CircuitBreaker.CircuitBreakerMetrics m = cb.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, m.state());
        assertEquals(1, m.successCount());
        assertEquals(failuresAtOpen, m.failureCount());
        assertNotNull(m.openedAt());
        assertNotNull(m.lastFailureTime());
        assertNotEquals(java.time.Instant.MIN, m.lastFailureTime());
    }

    @Test
    @DisplayName("Factory create(name) returns new instances each time")
    void testFactoryCreateNewInstances() {
        CircuitBreaker<String> c1 = CircuitBreaker.create("factory-a");
        CircuitBreaker<String> c2 = CircuitBreaker.create("factory-a");
        assertNotNull(c1);
        assertNotNull(c2);
        assertNotSame(c1, c2);
        assertEquals(CircuitBreaker.State.CLOSED, c1.getState());
        assertEquals(CircuitBreaker.State.CLOSED, c2.getState());
    }

    @Test
    @DisplayName("getOrCreate returns the same instance for the same name")
    void testGetOrCreateRegistrySameInstancePerName() {
        CircuitBreaker<String> r1 = CircuitBreaker.getOrCreate("registry-x", 5, 3, java.time.Duration.ofSeconds(1));
        CircuitBreaker<Integer> r2 = CircuitBreaker.getOrCreate("registry-x", 2, 2, java.time.Duration.ofSeconds(2));
        assertSame(r1, r2);
        CircuitBreaker<String> r3 = CircuitBreaker.getOrCreate("registry-y", 5, 3, java.time.Duration.ofSeconds(1));
        assertNotSame(r1, r3);
    }

    @Test
    @DisplayName("allowRequest returns true repeatedly in HALF_OPEN state")
    void testAllowRequestMultipleInHalfOpenTrue() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("half-open-allow", 1, 3, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(10));
        cb.recordFailure(); // OPEN
        Thread.sleep(120);
        assertTrue(cb.allowRequest()); // transitions to HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
        assertTrue(cb.allowRequest()); // still HALF_OPEN and allowed
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
    }
}