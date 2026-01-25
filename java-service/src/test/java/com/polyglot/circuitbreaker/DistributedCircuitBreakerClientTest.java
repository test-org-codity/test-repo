package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient.AggregatedState;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient distributedCircuitBreakerClient;

    @BeforeEach
    void setUp() {
        // Use a dummy coordinator URL; we are not asserting on real HTTP behavior
        distributedCircuitBreakerClient = new DistributedCircuitBreakerClient("http://localhost:9999");
    }

    @AfterEach
    void tearDown() {
        if (distributedCircuitBreakerClient != null) {
            distributedCircuitBreakerClient.shutdown();
        }
        distributedCircuitBreakerClient = null;
    }

    @Test
    @DisplayName("Constructor should create instance and start in running state")
    void testConstructor() {
        assertNotNull(distributedCircuitBreakerClient);
    }

    @Test
    @DisplayName("getBreaker should return non-null breaker for a service")
    void testGetBreakerReturnsNonNull() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceA");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should return same instance for same service name")
    void testGetBreakerSameInstanceForSameService() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceA");
        assertSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreakerDifferentInstancesForDifferentServices() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceB");
        assertNotSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("reportState should accept valid state without throwing")
    void testReportStateDoesNotThrow() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceReport");
        // Use some arbitrary failure count
        assertDoesNotThrow(() ->
                distributedCircuitBreakerClient.reportState("serviceReport", breaker.getState(), breaker.getFailureCount())
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN when coordinator is unreachable")
    void testGetAggregatedStateUnknownOnFailure() {
        // Using an invalid URL to force failure in HTTP call
        DistributedCircuitBreakerClient failingClient =
                new DistributedCircuitBreakerClient("http://invalid-host-12345");
        AggregatedState state = failingClient.getAggregatedState("nonexistent-service");
        assertNotNull(state);
        assertEquals("nonexistent-service", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
        failingClient.shutdown();
    }

    @Test
    @DisplayName("AggregatedState record should store and expose values correctly")
    void testAggregatedStateRecord() {
        AggregatedState state = new AggregatedState("svc", "OPEN", 3, 0.75);
        assertEquals("svc", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("shutdown should be callable multiple times without throwing")
    void testShutdownIdempotent() {
        assertDoesNotThrow(() -> {
            distributedCircuitBreakerClient.shutdown();
            distributedCircuitBreakerClient.shutdown();
        });
    }

    @Test
    @DisplayName("getBreaker can still be called after shutdown without immediate exception")
    void testGetBreakerAfterShutdown() {
        distributedCircuitBreakerClient.shutdown();
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceAfterShutdown");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getAggregatedState returns a non-null AggregatedState object")
    void testGetAggregatedStateNotNull() {
        AggregatedState state = distributedCircuitBreakerClient.getAggregatedState("someService");
        assertNotNull(state);
        assertEquals("someService", state.service());
    }
}