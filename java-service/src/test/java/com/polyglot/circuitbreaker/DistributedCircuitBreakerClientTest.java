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
    @DisplayName("Constructor should create instance with a background sync thread (no exception)")
    void testConstructor_CreatesInstance() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should return a non-null breaker for a service name")
    void testGetBreaker_ReturnsNonNull() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should return the same breaker instance for the same service name")
    void testGetBreaker_SameInstanceForSameService() {
        CircuitBreaker<Object> b1 = client.getBreaker("orders");
        CircuitBreaker<Object> b2 = client.getBreaker("orders");
        assertSame(b1, b2, "Expected computeIfAbsent to cache and return the same breaker instance");
    }

    @Test
    @DisplayName("getBreaker should create different breaker instances for different service names")
    void testGetBreaker_DifferentInstancesForDifferentServices() {
        CircuitBreaker<Object> b1 = client.getBreaker("orders");
        CircuitBreaker<Object> b2 = client.getBreaker("payments");
        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2);
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException when serviceName is null (ConcurrentHashMap does not permit null keys)")
    void testGetBreaker_NullServiceName_ThrowsNpe() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should not throw even if coordinator is unreachable")
    void testReportState_UnreachableCoordinator_DoesNotThrow() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertNotNull(breaker);

        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.CLOSED, 0));
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.OPEN, 5));
    }

    @Test
    @DisplayName("reportState should throw NullPointerException when state is null (state.name() is called)")
    void testReportState_NullState_ThrowsNpe() {
        assertThrows(NullPointerException.class, () -> client.reportState("orders", null, 1));
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
    @DisplayName("getAggregatedState should not throw when serviceName contains URL-unsafe characters; it should still fallback on failure")
    void testGetAggregatedState_WeirdServiceName_ReturnsUnknownFallback() {
        String serviceName = "orders/v1?x=1&y=2";
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState(serviceName);
        assertNotNull(state);

        assertEquals(serviceName, state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }

    @Test
    @DisplayName("After shutdown, public API calls should still not throw")
    void testAfterShutdown_PublicCallsDoNotThrow() {
        client.shutdown();

        assertDoesNotThrow(() -> {
            CircuitBreaker<Object> breaker = client.getBreaker("orders");
            assertNotNull(breaker);
        });

        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.CLOSED, 0));

        assertDoesNotThrow(() -> {
            DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("orders");
            assertNotNull(state);
        });
    }

    @Test
    @DisplayName("AggregatedState record should store values correctly")
    void testAggregatedState_RecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.75);

        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.000001);
    }
}