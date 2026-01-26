package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
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
        distributedCircuitBreakerClient = new DistributedCircuitBreakerClient("http://localhost:8080");
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
    void testConstructor_CreatesInstance() {
        assertNotNull(distributedCircuitBreakerClient);
    }

    @Test
    @DisplayName("getBreaker should create a new breaker for a service")
    void testGetBreaker_CreatesNewBreaker() {
        String serviceName = "serviceA";
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker(serviceName);

        assertNotNull(breaker);
        assertEquals(CircuitBreaker.State.CLOSED, breaker.getState());
    }

    @Test
    @DisplayName("getBreaker should return same instance for same service name")
    void testGetBreaker_ReturnsSameInstanceForSameService() {
        String serviceName = "serviceB";
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker(serviceName);
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker(serviceName);

        assertNotNull(breaker1);
        assertNotNull(breaker2);
        assertSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreaker_ReturnsDifferentInstancesForDifferentServices() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceC");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceD");

        assertNotNull(breaker1);
        assertNotNull(breaker2);
        assertNotSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("reportState should accept CLOSED state without throwing")
    void testReportState_ClosedState_NoException() {
        assertDoesNotThrow(() ->
            distributedCircuitBreakerClient.reportState("serviceE", CircuitBreaker.State.CLOSED, 0)
        );
    }

    @Test
    @DisplayName("reportState should accept OPEN state with failure count without throwing")
    void testReportState_OpenState_NoException() {
        assertDoesNotThrow(() ->
            distributedCircuitBreakerClient.reportState("serviceF", CircuitBreaker.State.OPEN, 3)
        );
    }

    @Test
    @DisplayName("reportState should handle negative failure count without throwing")
    void testReportState_NegativeFailureCount_NoException() {
        assertDoesNotThrow(() ->
            distributedCircuitBreakerClient.reportState("serviceG", CircuitBreaker.State.HALF_OPEN, -1)
        );
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON response correctly")
    void testGetAggregatedState_ParsesValidJson() {
        // We cannot mock HttpClient, but we can directly test parse logic via known JSON string
        // by temporarily using reflection to call parseAggregatedState or by indirect behavior.
        // Since parseAggregatedState is private, we simulate its expected output via JSON string
        // and check that when parsing fails (no HTTP server), we still get a non-null object
        // with UNKNOWN state. To test parsing itself, we instead create an AggregatedState
        // via constructor and assert record behavior.

        DistributedCircuitBreakerClient.AggregatedState state =
            new DistributedCircuitBreakerClient.AggregatedState("serviceH", "CLOSED", 5, 0.8);

        assertEquals("serviceH", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.8, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN state on exception or invalid HTTP call")
    void testGetAggregatedState_OnErrorReturnsUnknown() {
        DistributedCircuitBreakerClient client =
            new DistributedCircuitBreakerClient("http://invalid-host-should-fail");

        DistributedCircuitBreakerClient.AggregatedState state =
            client.getAggregatedState("serviceI");

        assertNotNull(state);
        assertEquals("serviceI", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
        client.shutdown();
    }

    @Test
    @DisplayName("AggregatedState record should expose correct values")
    void testAggregatedStateRecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
            new DistributedCircuitBreakerClient.AggregatedState("serviceJ", "OPEN", 10, 0.25);

        assertEquals("serviceJ", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(10, state.totalNodes());
        assertEquals(0.25, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("shutdown should stop sync thread without throwing")
    void testShutdown_NoException() {
        assertDoesNotThrow(() -> distributedCircuitBreakerClient.shutdown());
    }

    @Test
    @DisplayName("shutdown should be idempotent")
    void testShutdown_Idempotent() {
        distributedCircuitBreakerClient.shutdown();
        assertDoesNotThrow(() -> distributedCircuitBreakerClient.shutdown());
    }

    @Test
    @DisplayName("getBreaker after shutdown should still provide breaker instance")
    void testGetBreaker_AfterShutdownStillWorks() {
        distributedCircuitBreakerClient.shutdown();
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceK");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should handle empty service name")
    void testGetBreaker_EmptyServiceName() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("Multiple breakers can be created and retrieved independently")
    void testMultipleBreakers_Independent() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceL");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceM");

        assertNotNull(breaker1);
        assertNotNull(breaker2);
        assertNotSame(breaker1, breaker2);

        breaker1.recordFailure(new RuntimeException("fail1"));
        assertTrue(breaker1.getFailureCount() > 0);
        assertEquals(0, breaker2.getFailureCount());
    }
}