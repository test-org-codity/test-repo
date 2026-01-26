package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;

@DisplayName("CircuitBreaker Tests")
class CircuitBreakerTest {

    private CircuitBreaker<String> circuitBreaker;
    private Duration timeout;
    private String name;

    @BeforeEach
    void setUp() {
        name = "cb-" + System.nanoTime();
        timeout = Duration.ofMillis(120);
        circuitBreaker = new CircuitBreaker<>(name, 2, 2, timeout, Duration.ofMillis(50));
    }

    @AfterEach
    void tearDown() {
        circuitBreaker = null;
    }

    @Test
    @DisplayName("Initial state should be CLOSED and allow requests")
    void testInitialState() {
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertEquals(name, metrics.name());
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
        assertEquals(0, metrics.successCount());
        assertEquals(Instant.MIN, metrics.lastFailureTime());
        assertNull(metrics.openedAt());
    }

    @Test
    @DisplayName("execute: success should return value and keep CLOSED state with failureCount reset")
    void testExecuteSuccess() {
        // Make a failure first to ensure reset-on-success in CLOSED
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        String result = circuitBreaker.execute(() -> "OK");
        assertEquals("OK", result);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());
    }

    @Test
    @DisplayName("execute: failure should increment failureCount and rethrow")
    void testExecuteFailureIncrementsAndRethrows() {
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            circuitBreaker.execute(() -> { throw new RuntimeException("boom"); });
        });
        assertEquals("boom", ex.getMessage());
        assertEquals(1, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNotEquals(Instant.MIN, metrics.lastFailureTime());
    }

    @Test
    @DisplayName("Should transition to OPEN after reaching failure threshold and deny further execute calls")
    void testTransitionToOpenOnThresholdAndDenyExecute() {
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest());

        AtomicInteger executed = new AtomicInteger(0);
        assertThrows(CircuitBreaker.CircuitBreakerOpenException.class, () -> {
            circuitBreaker.execute(() -> {
                executed.incrementAndGet();
                return "should-not-run";
            });
        });
        assertEquals(0, executed.get());
    }

    @Test
    @DisplayName("OPEN -> HALF_OPEN after timeout; then CLOSED after reaching success threshold")
    void testOpenToHalfOpenToClosedAfterSuccesses() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse
        Thread.sleep(timeout.toMillis() + 50);

        // First allowRequest flips to HALF_OPEN and returns true
        boolean allowed = circuitBreaker.allowRequest();
        assertTrue(allowed);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // First success in HALF_OPEN - still HALF_OPEN
        String r1 = circuitBreaker.execute(() -> "ok1");
        assertEquals("ok1", r1);
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Second success reaches successThreshold -> CLOSED and reset
        String r2 = circuitBreaker.execute(() -> "ok2");
        assertEquals("ok2", r2);
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
        assertEquals(0, circuitBreaker.getFailureCount());

        CircuitBreaker.CircuitBreakerMetrics metrics = circuitBreaker.getMetrics();
        assertNull(metrics.openedAt());
        assertEquals(0, metrics.successCount());
    }

    @Test
    @DisplayName("HALF_OPEN failure should transition back to OPEN and set openedAt")
    void testHalfOpenFailureTransitionsBackToOpen() throws InterruptedException {
        // Open the breaker
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f1"); }));
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("f2"); }));
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse
        Thread.sleep(timeout.toMillis() + 50);

        // Next call attempts and transitions to HALF_OPEN; then failure re-opens
        assertThrows(RuntimeException.class, () -> circuitBreaker.execute(() -> { throw new RuntimeException("half-open-fail"); }));

        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertFalse(circuitBreaker.allowRequest()); // Immediately after reopen, timeout hasn't elapsed
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("recordSuccess in CLOSED should reset failureCount")
    void testRecordSuccessResetsFailureCountInClosed() {
        circuitBreaker.recordFailure();
        assertEquals(1, circuitBreaker.getFailureCount());

        circuitBreaker.recordSuccess();
        assertEquals(0, circuitBreaker.getFailureCount());
        assertEquals(CircuitBreaker.State.CLOSED, circuitBreaker.getState());
    }

    @Test
    @DisplayName("recordFailure in HALF_OPEN should immediately switch to OPEN")
    void testRecordFailureInHalfOpenOpensImmediately() throws InterruptedException {
        // Open the breaker
        circuitBreaker.recordFailure();
        circuitBreaker.recordFailure(); // threshold is 2
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());

        // Wait for timeout to elapse and move to HALF_OPEN via allowRequest
        Thread.sleep(timeout.toMillis() + 50);
        assertTrue(circuitBreaker.allowRequest());
        assertEquals(CircuitBreaker.State.HALF_OPEN, circuitBreaker.getState());

        // Now recordFailure should open immediately
        circuitBreaker.recordFailure();
        assertEquals(CircuitBreaker.State.OPEN, circuitBreaker.getState());
        assertNotNull(circuitBreaker.getMetrics().openedAt());
    }

    @Test
    @DisplayName("getOrCreate should return same instance for same name")
    void testGetOrCreateReturnsSameInstance() {
        String regName = "registry-" + System.nanoTime();
        CircuitBreaker<String> a = CircuitBreaker.getOrCreate(regName, 3, 2, Duration.ofMillis(10));
        CircuitBreaker<String> b = CircuitBreaker.getOrCreate(regName, 99, 99, Duration.ofSeconds(5));
        assertSame(a, b);
        assertEquals(CircuitBreaker.State.CLOSED, a.getState());
        assertTrue(a.allowRequest());
    }

    @Test
    @DisplayName("Factory create should produce CLOSED breaker allowing requests")
    void testFactoryCreate() {
        CircuitBreaker<Integer> cb = CircuitBreaker.create("factory-" + System.nanoTime());
        assertNotNull(cb);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertTrue(cb.allowRequest());

        CircuitBreaker.CircuitBreakerMetrics metrics = cb.getMetrics();
        assertEquals("factory-" + metrics.name().substring(metrics.name().lastIndexOf('-') + 1).replace(metrics.name().substring(metrics.name().lastIndexOf('-') + 1), ""), metrics.name().substring(0, metrics.name().lastIndexOf('-') + 1)); // name starts with "factory-"
        assertEquals(CircuitBreaker.State.CLOSED, metrics.state());
        assertEquals(0, metrics.failureCount());
    }
}