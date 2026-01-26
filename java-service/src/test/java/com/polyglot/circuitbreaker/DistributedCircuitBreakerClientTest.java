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
    @DisplayName("getBreaker should return a non-null breaker for a new service name")
    void testGetBreaker_NewService_ReturnsNonNullBreaker() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should return same instance for the same service name")
    void testGetBreaker_SameService_ReturnsSameInstance() {
        CircuitBreaker<Object> b1 = client.getBreaker("payments");
        CircuitBreaker<Object> b2 = client.getBreaker("payments");
        assertSame(b1, b2, "Expected same CircuitBreaker instance to be cached per service name");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreaker_DifferentServices_ReturnDifferentInstances() {
        CircuitBreaker<Object> b1 = client.getBreaker("inventory");
        CircuitBreaker<Object> b2 = client.getBreaker("shipping");
        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2);
    }

    @Test
    @DisplayName("getBreaker should not throw even if coordinator is unreachable (registration failure is handled)")
    void testGetBreaker_CoordinatorUnreachable_DoesNotThrow() {
        assertDoesNotThrow(() -> {
            CircuitBreaker<Object> breaker = client.getBreaker("unreachable-service");
            assertNotNull(breaker);
        });
    }

    @Test
    @DisplayName("reportState should not throw for valid inputs even if coordinator is unreachable")
    void testReportState_ValidInputs_DoesNotThrow() {
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.CLOSED, 0));
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.OPEN, 5));
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.HALF_OPEN, 2));
    }

    @Test
    @DisplayName("reportState should not throw with negative failureCount (method is defensive)")
    void testReportState_NegativeFailureCount_DoesNotThrow() {
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.CLOSED, -10));
    }

    @Test
    @DisplayName("reportState should not throw when serviceName is null (exception is handled internally)")
    void testReportState_NullServiceName_DoesNotThrow() {
        assertDoesNotThrow(() -> client.reportState(null, CircuitBreaker.State.CLOSED, 1));
    }

    @Test
    @DisplayName("reportState should not throw when state is null (exception is handled internally)")
    void testReportState_NullState_DoesNotThrow() {
        assertDoesNotThrow(() -> client.reportState("orders", null, 1));
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN fallback when coordinator is unreachable")
    void testGetAggregatedState_UnreachableCoordinator_ReturnsUnknownFallback() {
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("orders");

        assertNotNull(state);
        assertEquals("orders", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should not throw when serviceName is null and should return a non-null result")
    void testGetAggregatedState_NullServiceName_DoesNotThrow_ReturnsNonNull() {
        DistributedCircuitBreakerClient.AggregatedState state = assertDoesNotThrow(() -> client.getAggregatedState(null));
        assertNotNull(state);
        // The fallback path uses the provided serviceName directly; null is acceptable here.
        assertNull(state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("AggregatedState record should store values and provide correct accessors")
    void testAggregatedState_RecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.85);

        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.85, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent_DoesNotThrow() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }

    @Test
    @DisplayName("Client methods should remain callable after shutdown (no exceptions expected)")
    void testMethods_AfterShutdown_DoNotThrow() {
        client.shutdown();

        assertDoesNotThrow(() -> {
            CircuitBreaker<Object> breaker = client.getBreaker("after-shutdown");
            assertNotNull(breaker);
        });

        assertDoesNotThrow(() -> client.reportState("after-shutdown", CircuitBreaker.State.CLOSED, 0));

        DistributedCircuitBreakerClient.AggregatedState state =
                assertDoesNotThrow(() -> client.getAggregatedState("after-shutdown"));
        assertNotNull(state);
    }
}