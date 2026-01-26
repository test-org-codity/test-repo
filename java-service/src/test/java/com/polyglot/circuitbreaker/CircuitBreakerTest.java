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
        circuitBreaker = new CircuitBreaker<>("test", 2, 2, java.time.Duration.ofMillis(200), java.time.Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state is CLOSED and metrics default values")
    void testInitialStateAndMetrics() {
        assertNotNull(circuitBreaker);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals("test", metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("Execute success in CLOSED resets failure count")
    void testExecuteSuccessInClosedResetsFailureCount() {
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("fail");
        }));
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("Execute failure increments count and opens at threshold")
    void testExecuteFailureIncrementsAndOpensAtThreshold() {
        // threshold = 2
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("boom1");
        }));
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(1, circuitBreaker.getFailureCount());

        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new RuntimeException("boom2");
        }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertEquals(2, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotEquals(java.time.Instant.MIN, metrics.lastFailureTime());
        assertNotNull(metrics.openedAt());

        // While OPEN and before timeout, request should be denied
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> circuitBreaker.execute(() -> "should-not-run"));
    }

    @Test
    @DisplayName("OPEN -> HALF_OPEN after timeout via allowRequest")
    void testAllowRequestOpenToHalfOpenAfterTimeout() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("short", 1, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail to open");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());

        sleep(150); // wait beyond timeout
        boolean allowed = cb.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
    }

    @Test
    @DisplayName("HALF_OPEN requires consecutive successes to close")
    void testHalfOpenConsecutiveSuccessesClose() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("half", 1, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));

        // Open it
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("open");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Wait to transition to HALF_OPEN
        sleep(150);
        String first = cb.execute(() -> "first-success");
        assertEquals("first-success", first);
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        String second = cb.execute(() -> "second-success");
        assertEquals("second-success", second);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertNull(metrics.openedAt());
        assertEquals(0, cb.getFailureCount());
    }

    @Test
    @DisplayName("Failure in HALF_OPEN reopens the circuit")
    void testHalfOpenFailureReopens() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("half-failure", 1, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));

        // Open it
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("open");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Wait and allow HALF_OPEN
        sleep(150);
        assertEquals("ok", cb.execute(() -> "ok")); // success, remains HALF_OPEN (needs 2)
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        // Next call fails -> should go OPEN
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertNotNull(cb.getMetrics().openedAt());

        // Before timeout, should throw open exception
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> "blocked"));
    }

    @Test
    @DisplayName("Registry getOrCreate returns same instance for same name")
    void testRegistryGetOrCreateReturnsSameInstance() {
        CircuitBreaker<Object> a = CircuitBreaker.getOrCreate("registry-cb", 3, 2, java.time.Duration.ofMillis(100));
        CircuitBreaker<Object> b = CircuitBreaker.getOrCreate("registry-cb", 5, 5, java.time.Duration.ofMillis(500));
        assertSame(a, b);
    }

    @Test
    @DisplayName("Metrics reflect lastFailureTime and openedAt transitions")
    void testMetricsReflectsTimesAndOpenedAt() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("metrics", 1, 1, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));

        // Cause failure -> OPEN
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail");
        }));
        CircuitBreaker.CircuitBreakerMetrics openMetrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.OPEN, openMetrics.state());
        assertNotEquals(java.time.Instant.MIN, openMetrics.lastFailureTime());
        assertNotNull(openMetrics.openedAt());

        // Wait and then one success to close (successThreshold=1)
        sleep(150);
        assertEquals("ok", cb.execute(() -> "ok"));
        CircuitBreaker.CircuitBreakerMetrics closedMetrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.CLOSED, closedMetrics.state());
        assertNull(closedMetrics.openedAt());
        assertEquals(0, closedMetrics.failureCount());
        assertEquals(0, closedMetrics.successCount());
    }

    @Test
    @DisplayName("Execute rethrows the original runtime exception")
    void testExecuteRethrowsOriginalRuntimeException() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> {
            throw new IllegalStateException("boom");
        }));
        assertTrue(ex instanceof IllegalStateException);
        assertEquals("boom", ex.getMessage());
    }

    @Test
    @DisplayName("Static create returns CLOSED circuit with requests allowed")
    void testCreateStaticDefaultsClosed() {
        CircuitBreaker<String> cb = CircuitBreaker.create("defaults");
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());
    }

    @Test
    @DisplayName("Execute throws CircuitBreakerOpenException when OPEN and before timeout")
    void testOpenExceptionWhenOpenAndBeforeTimeout() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("open-throw", 1, 1, java.time.Duration.ofMillis(200), java.time.Duration.ofMillis(50));
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail to open");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> cb.execute(() -> "should-not-run"));
    }

    @Test
    @DisplayName("Success count resets to 0 on new HALF_OPEN attempt")
    void testSuccessCountResetOnNewHalfOpenAttempt() {
        CircuitBreaker<String> cb = new CircuitBreaker<>("success-reset", 1, 2, java.time.Duration.ofMillis(100), java.time.Duration.ofMillis(50));

        // Open
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail");
        }));
        // Transition to HALF_OPEN and get one success (successCount becomes 1)
        sleep(150);
        assertEquals("ok", cb.execute(() -> "ok"));
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());

        // Fail to reopen
        assertThrows(RuntimeException.class, () -> cb.execute(() -> {
            throw new RuntimeException("fail");
        }));
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        // Next HALF_OPEN attempt should reset successCount to 0
        sleep(150);
        assertTrue(cb.allowRequest()); // transition OPEN -> HALF_OPEN and zero successCount
        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals(CircuitBreaker.State.HALF_OPEN, metrics.state());
        assertEquals(0, metrics.successCount());
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            fail("Test interrupted");
        }
    }
}