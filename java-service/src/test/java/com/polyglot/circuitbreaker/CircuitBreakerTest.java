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
        circuitBreaker = new CircuitBreaker<>(name, 3, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(10));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor initializes CLOSED state and default metrics")
    void testConstructorInitialization() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(name, metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute returns value on success and resets failure count in CLOSED")
    void testExecute_SuccessInClosedResetsFailures() {
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("fail"); }));
        assertTrue(circuitBreaker.getFailureCount() >= 1);

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure trips to OPEN after reaching failure threshold")
    void testRecordFailure_TripToOpenAfterThreshold() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("open-" + System.nanoTime(), 2, 1, java.time.Duration.ofMillis(200), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertNotEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNotNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute throws CircuitBreakerOpenException when OPEN and not timed out")
    void testExecute_ThrowsCircuitBreakerOpenWhenOpenAndNotTimedOut() {
        CircuitBreaker<Integer> cb = new CircuitBreaker<>("open-exec-" + System.nanoTime(), 1, 1, java.time.Duration.ofMillis(200), java.time.Duration.ofMillis(10));

        assertThrows(RuntimeException.class, () -> cb.execute(() -> { throw new RuntimeException("boom"); }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> 42));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
    }

    @Test
    @DisplayName("allowRequest transitions OPEN to HALF_OPEN after timeout")
    void testAllowRequestAfterTimeoutTransitionsToHalfOpen() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("halfopen-" + System.nanoTime(), 1, 2, java.time.Duration.ofMillis(50), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(80); // wait for timeout
        boolean allowed = cb.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
    }

    @Test
    @DisplayName("In HALF_OPEN, enough successes close the circuit and reset metrics")
    void testHalfOpen_SuccessesLeadToClose() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("halfopen-success-" + System.nanoTime(), 1, 2, java.time.Duration.ofMillis(50), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(80);
        String r1 = cb.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        String r2 = cb.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertNull(metrics.openedAt());
        assertEquals(0, metrics.successCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure trips back to OPEN immediately")
    void testHalfOpen_FailureTripsBackToOpen() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("halfopen-failure-" + System.nanoTime(), 1, 2, java.time.Duration.ofMillis(50), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(80);
        assertThrows(RuntimeException.class, () -> cb.execute(() -> { throw new RuntimeException("fail"); }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertNotNull(cb.getMetrics().openedAt());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> "should not run"));
    }

    @Test
    @DisplayName("getMetrics reflects lastFailureTime and name")
    void testGetMetricsReflectsStateAndTimes() {
        CircuitBreaker.CircuitBreakerMetrics initial = circuitBreaker.getMetrics();
        assertEquals(java.time.Instant.MIN, initial.lastFailureTime());
        assertEquals(name, initial.name());

        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics afterFailure = circuitBreaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, afterFailure.lastFailureTime());
        assertEquals(name, afterFailure.name());
    }

    @Test
    @DisplayName("Factory create() returns a usable CLOSED circuit breaker")
    void testCreateFactoryMethod() {
        CircuitBreaker<String> cb = CircuitBreaker.create("factory-" + System.nanoTime());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
        String result = cb.execute(() -> "hello");
        assertEquals("hello", result);
    }

    @Test
    @DisplayName("getOrCreate registry returns the same instance for the same name")
    void testGetOrCreateRegistryReturnsSameInstance() {
        String regName = "registry-" + System.nanoTime();
        CircuitBreaker<String> cb1 = CircuitBreaker.getOrCreate(regName, 2, 2, java.time.Duration.ofMillis(500));
        CircuitBreaker<String> cb2 = CircuitBreaker.getOrCreate(regName, 5, 4, java.time.Duration.ofMillis(1000));
        assertSame(cb1, cb2);

        CircuitBreaker<String> cb3 = CircuitBreaker.getOrCreate("registry-diff-" + System.nanoTime(), 2, 2, java.time.Duration.ofMillis(500));
        assertNotSame(cb1, cb3);
    }

    @Test
    @DisplayName("allowRequest returns true when CLOSED")
    void testAllowRequestWhenClosedReturnsTrue() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failure count")
    void testRecordSuccessInClosedResetsFailureCount() {
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertTrue(circuitBreaker.getFailureCount() >= 2);

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getFailureCount reflects increments")
    void testGetFailureCountReflectsIncrements() {
        assertEquals(0, circuitBreaker.getFailureCount());
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        assertEquals(2, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Zero failure threshold opens immediately on first failure")
    void testZeroFailureThresholdOpensImmediately() {
        CircuitBreaker<Void> cb = new CircuitBreaker<>("zero-fail-" + System.nanoTime(), 0, 1, java.time.Duration.ofMillis(50), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertNotNull(cb.getMetrics().openedAt());
    }

    @Test
    @DisplayName("Zero success threshold closes immediately after first HALF_OPEN success")
    void testZeroSuccessThresholdClosesImmediatelyOnHalfOpenSuccess() throws InterruptedException {
        CircuitBreaker<String> cb = new CircuitBreaker<>("zero-success-" + System.nanoTime(), 1, 0, java.time.Duration.ofMillis(50), java.time.Duration.ofMillis(10));
        cb.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(80);
        String res = cb.execute(() -> "x");
        assertEquals("x", res);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertNull(cb.getMetrics().openedAt());
    }
}