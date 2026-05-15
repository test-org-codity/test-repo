package com.polyglot.circuitbreaker;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

public class CircuitBreaker<T> {
    
    public enum State {
        CLOSED, OPEN, HALF_OPEN
    }
    
    private final String name;
    private final int failureThreshold;
    private final int successThreshold;
    private final Duration timeout;
    private final Duration halfOpenTimeout;
    
    private final AtomicReference<State> state = new AtomicReference<>(State.CLOSED);
    private final AtomicInteger failureCount = new AtomicInteger(0);
    private final AtomicInteger successCount = new AtomicInteger(0);
    private final AtomicReference<Instant> lastFailureTime = new AtomicReference<>(Instant.MIN);
    private final AtomicReference<Instant> openedAt = new AtomicReference<>(null);
    
    private static final ConcurrentHashMap<String, CircuitBreaker<?>> registry = new ConcurrentHashMap<>();
    
    public CircuitBreaker(String name, int failureThreshold, int successThreshold, 
                          Duration timeout, Duration halfOpenTimeout) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.successThreshold = successThreshold;
        this.timeout = timeout;
        this.halfOpenTimeout = halfOpenTimeout;
    }
    
    public static <T> CircuitBreaker<T> create(String name) {
        return new CircuitBreaker<>(name, 5, 3, Duration.ofSeconds(30), Duration.ofSeconds(10));
    }
    
    @SuppressWarnings("unchecked")
    public static <T> CircuitBreaker<T> getOrCreate(String name, int failureThreshold, 
                                                     int successThreshold, Duration timeout) {
        return (CircuitBreaker<T>) registry.computeIfAbsent(name, 
            k -> new CircuitBreaker<T>(name, failureThreshold, successThreshold, timeout, Duration.ofSeconds(10)));
    }
    
    public T execute(Supplier<T> operation) throws CircuitBreakerOpenException {
        if (!allowRequest()) {
            throw new CircuitBreakerOpenException("Circuit breaker '" + name + "' is open");
        }
        
        try {
            T result = operation.get();
            recordSuccess();
            return result;
        } catch (Exception e) {
            recordFailure();
            throw e;
        }
    }
    
    public boolean allowRequest() {
        State currentState = state.get();
        
        switch (currentState) {
            case CLOSED:
                return true;
            case OPEN:
                if (shouldAttemptReset()) {
                    if (state.compareAndSet(State.OPEN, State.HALF_OPEN)) {
                        successCount.set(0);
                        return true;
                    }
                }
                return false;
            case HALF_OPEN:
                return true;
            default:
                return false;
        }
    }
    
    private boolean shouldAttemptReset() {
        Instant opened = openedAt.get();
        if (opened == null) return false;
        return Duration.between(opened, Instant.now()).compareTo(timeout) >= 0;
    }
    
    public void recordSuccess() {
        State currentState = state.get();
        
        if (currentState == State.HALF_OPEN) {
            int successes = successCount.incrementAndGet();
            if (successes >= successThreshold) {
                if (state.compareAndSet(State.HALF_OPEN, State.CLOSED)) {
                    reset();
                }
            }
        } else if (currentState == State.CLOSED) {
            failureCount.set(0);
        }
    }
    
    public void recordFailure() {
        lastFailureTime.set(Instant.now());
        State currentState = state.get();
        
        if (currentState == State.HALF_OPEN) {
            state.compareAndSet(State.HALF_OPEN, State.OPEN);
            openedAt.set(Instant.now());
        } else if (currentState == State.CLOSED) {
            int failures = failureCount.incrementAndGet();
            if (failures >= failureThreshold) {
                if (state.compareAndSet(State.CLOSED, State.OPEN)) {
                    openedAt.set(Instant.now());
                }
            }
        }
    }
    
    private void reset() {
        failureCount.set(0);
        successCount.set(0);
        openedAt.set(null);
    }
    
    public State getState() {
        return state.get();
    }
    
    public int getFailureCount() {
        return failureCount.get();
    }
    
    public CircuitBreakerMetrics getMetrics() {
        return new CircuitBreakerMetrics(
            name,
            state.get(),
            failureCount.get(),
            successCount.get(),
            lastFailureTime.get(),
            openedAt.get()
        );
    }
    
    public record CircuitBreakerMetrics(
        String name,
        State state,
        int failureCount,
        int successCount,
        Instant lastFailureTime,
        Instant openedAt
    ) {}
    
    public static class CircuitBreakerOpenException extends RuntimeException {
        public CircuitBreakerOpenException(String message) {
            super(message);
        }
    }
}
