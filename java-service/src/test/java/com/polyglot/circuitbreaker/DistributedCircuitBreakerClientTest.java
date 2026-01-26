package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient client;

    @BeforeEach
    void setUp() {
        client = new DistributedCircuitBreakerClient("http://localhost:1");
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            client.shutdown();
        }
        client = null;
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor_CreatesInstance() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should return a non-null breaker")
    void testGetBreaker_ReturnsNonNull() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should cache and return the same breaker instance for the same service name")
    void testGetBreaker_CachesByServiceName() {
        CircuitBreaker<Object> b1 = client.getBreaker("inventory");
        CircuitBreaker<Object> b2 = client.getBreaker("inventory");

        assertNotNull(b1);
        assertSame(b1, b2, "Expected same instance to be returned from cache for identical service name");
    }

    @Test
    @DisplayName("getBreaker should return different breaker instances for different service names")
    void testGetBreaker_DifferentServicesDifferentInstances() {
        CircuitBreaker<Object> b1 = client.getBreaker("payments");
        CircuitBreaker<Object> b2 = client.getBreaker("shipping");

        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2, "Expected different instances for different service names");
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException when serviceName is null (ConcurrentHashMap does not allow null keys)")
    void testGetBreaker_NullServiceName_Throws() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should not throw for valid inputs (errors are handled internally)")
    void testReportState_DoesNotThrow() {
        assertDoesNotThrow(() ->
            client.reportState("orders", CircuitBreaker.State.CLOSED, 0)
        );
    }

    @Test
    @DisplayName("reportState should not throw even when serviceName is null (exception is caught internally)")
    void testReportState_NullServiceName_DoesNotThrow() {
        assertDoesNotThrow(() ->
            client.reportState(null, CircuitBreaker.State.CLOSED, 0)
        );
    }

    @Test
    @DisplayName("reportState should not throw even when state is null (exception is caught internally)")
    void testReportState_NullState_DoesNotThrow() {
        assertDoesNotThrow(() ->
            client.reportState("orders", null, 1)
        );
    }

    @Test
    @DisplayName("reportState should not throw for negative failureCount (serialized as-is; errors are handled internally)")
    void testReportState_NegativeFailureCount_DoesNotThrow() {
        assertDoesNotThrow(() ->
            client.reportState("orders", CircuitBreaker.State.OPEN, -10)
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on network/HTTP failure and not throw")
    void testGetAggregatedState_OnFailure_ReturnsUnknown() {
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("orders");

        assertNotNull(state);
        assertEquals("orders", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should not throw even when serviceName is null")
    void testGetAggregatedState_NullServiceName_DoesNotThrowAndReturnsUnknown() {
        DistributedCircuitBreakerClient.AggregatedState state = assertDoesNotThrow(() -> client.getAggregatedState(null));

        assertNotNull(state);
        assertNull(state.service(), "Service is expected to be null when called with null serviceName (constructor argument used directly)");
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("AggregatedState record should expose constructor values via accessors")
    void testAggregatedState_RecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
            new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.75);

        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("AggregatedState record should implement value-based equality")
    void testAggregatedState_ValueBasedEquality() {
        DistributedCircuitBreakerClient.AggregatedState a =
            new DistributedCircuitBreakerClient.AggregatedState("svc", "OPEN", 2, 0.5);
        DistributedCircuitBreakerClient.AggregatedState b =
            new DistributedCircuitBreakerClient.AggregatedState("svc", "OPEN", 2, 0.5);
        DistributedCircuitBreakerClient.AggregatedState c =
            new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 2, 0.5);

        assertEquals(a, b);
        assertEquals(a.hashCode(), b.hashCode());
        assertNotEquals(a, c);
    }

    @Test
    @DisplayName("shutdown should be callable and idempotent (should not throw when called multiple times)")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }
}