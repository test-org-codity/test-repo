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
        circuitBreaker = new CircuitBreaker<>("test-cb", 2, 2, java.time.Duration.ofMillis(150), java.time.Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Constructor initializes CLOSED state and default metrics")
    void testConstructorAndInitialState() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals("test-cb", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute returns result and remains CLOSED on success")
    void testExecute_SuccessInClosed() {
        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute rethrows exception and increments failure count in CLOSED")
    void testExecute_FailureInClosed_IncrementsCountAndRethrows() {
        RuntimeException ex = assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("fail"); })
        );
        assertEquals("fail", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Transitions to OPEN after reaching failure threshold and rejects calls")
    void testOpenAfterThresholdFailuresAndRejectsCalls() {
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
        assertNotNull(circuitBreaker.getMetrics().openedAt());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
            circuitBreaker.execute(() -> "value")
        );
    }

    @Test
    @DisplayName("allowRequest moves to HALF_OPEN after timeout elapses")
    void testAllowRequestBecomesHalfOpenAfterTimeout() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Before timeout: still not allowed
        assertFalse(circuitBreaker.allowRequest());

        // After timeout: should move to HALF_OPEN and allow one probe
        Thread.sleep(200);
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getMetrics().successCount());
    }

    @Test
    @DisplayName("In HALF_OPEN, enough successes transition to CLOSED and reset counters")
    void testHalfOpenSuccessesCloseBreaker() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout and perform two successful probes
        Thread.sleep(200);
        String r1 = circuitBreaker.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        String r2 = circuitBreaker.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
        assertNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("In HALF_OPEN, a failure transitions back to OPEN and sets openedAt")
    void testHalfOpenFailureReopensBreaker() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout then attempt failing probe
        Thread.sleep(200);
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("probe-fail"); })
        );

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED resets failure count")
    void testRecordSuccessInClosedResetsFailureCount() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("getOrCreate returns same instance for same name and different for different names")
    void testGetOrCreate_ReturnsSingletonPerName() {
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate("shared-name-1", 3, 2, java.time.Duration.ofMillis(100));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate("shared-name-1", 5, 5, java.time.Duration.ofMillis(1));
        assertSame(a, b);

        CircuitBreaker<String> c = CircuitBreaker.getOrCreate("shared-name-2", 3, 2, java.time.Duration.ofMillis(100));
        assertNotSame(a, c);
    }

    @Test
    @DisplayName("Factory create() returns a CLOSED breaker allowing requests")
    void testCreateFactoryMethod() {
        CircuitBreaker<String> created = CircuitBreaker.create("factory-cb");
        assertNotNull(created);
        assertEquals(CircuitBreaker.State.CLOSED, created.getState());
        assertTrue(created.allowRequest());
    }

    @Test
    @DisplayName("Metrics reflect latest failure and state")
    void testMetricsAfterFailure() {
        circuitBreaker.recordFailure();
        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();

        assertEquals("test-cb", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(1, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertTrue(metrics.lastFailureTime().isAfter(java.time.Instant.MIN));
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("In OPEN state before timeout, allowRequest returns false")
    void testAllowRequestOpenBeforeTimeoutFalse() {
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());
    }

    @Test
    @DisplayName("execute throws CircuitBreakerOpenException when OPEN and not timed out")
    void testExecuteThrowsWhenOpen() {
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom1"); })
        );
        assertThrows(RuntimeException.class, () ->
            circuitBreaker.execute(() -> { throw new RuntimeException("boom2"); })
        );
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () ->
            circuitBreaker.execute(() -> "should-not-run")
        );
    }
}