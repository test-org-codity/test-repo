package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import com.polyglot.circuitbreaker.CircuitBreaker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient distributedCircuitBreakerClient;
    private static final String COORDINATOR_URL = "http://localhost:8080";

    @BeforeEach
    void setUp() {
        distributedCircuitBreakerClient = new DistributedCircuitBreakerClient(COORDINATOR_URL);
    }

    @AfterEach
    void tearDown() {
        if (distributedCircuitBreakerClient != null) {
            distributedCircuitBreakerClient.shutdown();
        }
        distributedCircuitBreakerClient = null;
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(distributedCircuitBreakerClient);
    }

    @Test
    @DisplayName("getBreaker should return non-null CircuitBreaker for a service")
    void testGetBreaker_ReturnsNonNull() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceA");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should return same instance for same service name")
    void testGetBreaker_SameInstanceForSameService() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceA");
        assertSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreaker_DifferentInstanceForDifferentService() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceB");
        assertNotSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("reportState should accept valid state without throwing exception")
    void testReportState_NoException() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceReport");
        assertDoesNotThrow(() ->
                distributedCircuitBreakerClient.reportState(
                        "serviceReport",
                        breaker.getState(),
                        breaker.getFailureCount()
                )
        );
    }

    @Test
    @DisplayName("reportState should handle negative failureCount without throwing exception")
    void testReportState_NegativeFailureCount_NoException() {
        assertDoesNotThrow(() ->
                distributedCircuitBreakerClient.reportState(
                        "serviceNegative",
                        CircuitBreaker.State.CLOSED,
                        -1
                )
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN state on coordinator error or unreachable")
    void testGetAggregatedState_UnknownOnError() {
        DistributedCircuitBreakerClient clientWithBadUrl =
                new DistributedCircuitBreakerClient("http://invalid-host-12345");
        try {
            DistributedCircuitBreakerClient.AggregatedState state =
                    clientWithBadUrl.getAggregatedState("someService");
            assertNotNull(state);
            assertEquals("someService", state.service());
            assertEquals("UNKNOWN", state.consensusState());
            assertEquals(0, state.totalNodes());
            assertEquals(0.0, state.healthScore(), 0.0001);
        } finally {
            clientWithBadUrl.shutdown();
        }
    }

    @Test
    @DisplayName("AggregatedState record should correctly expose its properties")
    void testAggregatedStateRecordProperties() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState(
                        "serviceX",
                        "OPEN",
                        5,
                        0.75
                );

        assertEquals("serviceX", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("shutdown should stop sync thread without affecting existing breaker retrieval")
    void testShutdown_AllowsExistingBreakerAccess() {
        CircuitBreaker<Object> breakerBefore = distributedCircuitBreakerClient.getBreaker("serviceShutdown");
        distributedCircuitBreakerClient.shutdown();

        // After shutdown, previously obtained breaker should still be usable
        assertNotNull(breakerBefore);
        assertDoesNotThrow(breakerBefore::getState);
    }

    @Test
    @DisplayName("Multiple shutdown calls should not throw exceptions")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> {
            distributedCircuitBreakerClient.shutdown();
            distributedCircuitBreakerClient.shutdown();
        });
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON correctly (indirectly via error-free call)")
    void testGetAggregatedState_ValidJsonParsingIndirect() {
        // We cannot easily inject a fake HttpClient without additional libraries,
        // but we can at least ensure the method can be called without NPEs
        assertDoesNotThrow(() ->
                distributedCircuitBreakerClient.getAggregatedState("serviceParseTest")
        );
    }
}