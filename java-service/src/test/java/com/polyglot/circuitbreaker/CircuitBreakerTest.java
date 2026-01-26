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
        circuitBreaker = new CircuitBreaker<>(
                name,
                3, // failureThreshold
                2, // successThreshold
                java.time.Duration.ofMillis(200), // timeout
                java.time.Duration.ofMillis(50)   // halfOpenTimeout (unused in logic)
        );
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state should be CLOSED and allow requests")
    void testInitialStateAndAllowRequest() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should return value and record success while CLOSED")
    void testExecuteSuccess() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("recordFailure increments count and opens at threshold")
    void testRecordFailureIncrementsAndOpensAtThreshold() {
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(3, circuitBreaker.getFailureCount());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute should throw CircuitBreakerOpenException when OPEN and timeout not elapsed")
    void testExecuteThrowsWhenOpen() {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "open-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(300),
                java.time.Duration.ofMillis(50)
        );
        // Trip to OPEN
        local.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, local.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> local.execute(() -> "result"));
    }

    @Test
    @DisplayName("execute should rethrow supplier runtime exception and record failure")
    void testExecuteRethrowsSupplierExceptionAndRecordsFailure() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            circuitBreaker.execute(() -> {
                throw new RuntimeException("Boom");
            });
        });
        assertEquals("Boom", ex.getMessage());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotNull(metrics);
        assertNotEquals(java.time.Instant.MIN, metrics.lastFailureTime());
    }

    @Test
    @DisplayName("OPEN transitions to HALF_OPEN after timeout when allowRequest is called")
    void testOpenTransitionsToHalfOpenAfterTimeoutOnAllowRequest() throws InterruptedException {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "halfopen-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(150),
                java.time.Duration.ofMillis(50)
        );
        local.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, local.getState());
        assertFalse(local.allowRequest());

        Thread.sleep(200); // exceed timeout
        boolean allowed = local.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, local.getState());
    }

    @Test
    @DisplayName("HALF_OPEN allows multiple requests")
    void testHalfOpenAllowsMultipleRequests() throws InterruptedException {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "multi-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(120),
                java.time.Duration.ofMillis(50)
        );
        local.recordFailure(); // OPEN
        Thread.sleep(150);
        assertTrue(local.allowRequest()); // move to HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, local.getState());

        assertTrue(local.allowRequest());
        assertTrue(local.allowRequest());
    }

    @Test
    @DisplayName("HALF_OPEN closes after reaching successThreshold successes")
    void testHalfOpenClosesAfterSuccessThreshold() throws InterruptedException {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "success-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(120),
                java.time.Duration.ofMillis(50)
        );
        local.recordFailure(); // OPEN
        Thread.sleep(150);
        assertTrue(local.allowRequest()); // move to HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, local.getState());

        local.recordSuccess(); // 1st success in HALF_OPEN: remain HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, local.getState());

        local.recordSuccess(); // 2nd success reaches successThreshold: CLOSE and reset
        assertEquals(CircuitBreaker.State.CLOSED, local.getState());
        assertEquals(0, local.getFailureCount());
        assertTrue(local.allowRequest());
    }

    @Test
    @DisplayName("HALF_OPEN failure immediately re-opens the breaker")
    void testHalfOpenFailureReopens() throws InterruptedException {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "reopen-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(120),
                java.time.Duration.ofMillis(50)
        );
        local.recordFailure(); // OPEN
        Thread.sleep(150);
        assertTrue(local.allowRequest()); // move to HALF_OPEN
        assertEquals(CircuitBreaker.State.HALF_OPEN, local.getState());

        local.recordFailure(); // should reopen
        assertEquals(CircuitBreaker.State.OPEN, local.getState());
        assertFalse(local.allowRequest());
    }

    @Test
    @DisplayName("recordSuccess while CLOSED resets failureCount")
    void testRecordSuccessResetsFailureCountWhenClosed() {
        circuitBreaker.recordFailure(); // failureCount = 1, still CLOSED
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess(); // should reset failures
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Metrics snapshot reflects name, state, counts, and timestamps")
    void testMetricsSnapshot() {
        CircuitBreaker.CircuitBreakerMetrics initial = circuitBreaker.getMetrics();
        assertEquals(name, initial.name());
        assertEquals(CircuitBreaker.State.CLOSED, initial.state());
        assertEquals(0, initial.failureCount());
        assertEquals(0, initial.successCount());
        assertEquals(java.time.Instant.MIN, initial.lastFailureTime());
        assertNull(initial.openedAt());

        // Trip to OPEN
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure();

        CircuitBreaker.CircuitBreakerMetrics after = circuitBreaker.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, after.state());
        assertEquals(3, after.failureCount());
        assertNotEquals(java.time.Instant.MIN, after.lastFailureTime());
        assertNotNull(after.openedAt());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        String regName = "registry-" + System.nanoTime();
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(
                regName, 2, 2, java.time.Duration.ofMillis(100)
        );
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(
                regName, 5, 5, java.time.Duration.ofSeconds(1)
        );
        assertSame(a, b);
        assertTrue(a.allowRequest());
    }

    @Test
    @DisplayName("Factory create returns CLOSED instance that allows requests")
    void testCreateFactory() {
        CircuitBreaker<String> created = CircuitBreaker.create("simple-" + System.nanoTime());
        assertNotNull(created);
        assertEquals(CircuitBreaker.State.CLOSED, created.getState());
        assertTrue(created.allowRequest());
    }

    @Test
    @DisplayName("OPEN does not auto transition before timeout")
    void testOpenDoesNotTransitionBeforeTimeout() throws InterruptedException {
        CircuitBreaker<String> local = new CircuitBreaker<>(
                "no-transition-" + System.nanoTime(),
                1,
                2,
                java.time.Duration.ofMillis(300),
                java.time.Duration.ofMillis(50)
        );
        local.recordFailure(); // OPEN
        assertEquals(CircuitBreaker.State.OPEN, local.getState());
        Thread.sleep(100); // less than timeout
        assertFalse(local.allowRequest());
        assertEquals(CircuitBreaker.State.OPEN, local.getState());
    }
}