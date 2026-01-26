package com.polyglot.circuitbreaker;

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
        // Use an invalid-ish URL to avoid relying on any real coordinator.
        // The implementation should catch exceptions for network failures.
        client = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            assertDoesNotThrow(() -> client.shutdown());
        }
        client = null;
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor_createsInstance() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should create a breaker for a new service name")
    void testGetBreaker_createsBreaker() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertNotNull(breaker);
    }

    @Test
    @DisplayName("getBreaker should return the same breaker instance for the same service name")
    void testGetBreaker_returnsSameInstanceForSameService() {
        CircuitBreaker<Object> b1 = client.getBreaker("inventory");
        CircuitBreaker<Object> b2 = client.getBreaker("inventory");
        assertSame(b1, b2, "Expected computeIfAbsent to return the same cached breaker instance");
    }

    @Test
    @DisplayName("getBreaker should return different breaker instances for different services")
    void testGetBreaker_returnsDifferentInstancesForDifferentServices() {
        CircuitBreaker<Object> b1 = client.getBreaker("payments");
        CircuitBreaker<Object> b2 = client.getBreaker("shipping");
        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2);
    }

    @Test
    @DisplayName("getBreaker should throw for null service name (ConcurrentHashMap does not support null keys)")
    void testGetBreaker_withNullServiceName_doesNotThrow() {
        // The underlying cache is typically a ConcurrentHashMap which forbids null keys.
        // Verify behavior is explicit and stable.
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should not throw for valid inputs even if coordinator is unreachable")
    void testReportState_doesNotThrow_whenCoordinatorUnreachable() {
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.CLOSED, 0));
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.OPEN, 10));
        assertDoesNotThrow(() -> client.reportState("orders", CircuitBreaker.State.HALF_OPEN, 2));
    }

    @Test
    @DisplayName("reportState should tolerate null serviceName and still not throw")
    void testReportState_nullServiceName_doesNotThrow() {
        assertDoesNotThrow(() -> client.reportState(null, CircuitBreaker.State.CLOSED, 1));
    }

    @Test
    @DisplayName("reportState should tolerate null state and not throw (exception should be caught internally)")
    void testReportState_nullState_doesNotThrow() {
        assertDoesNotThrow(() -> client.reportState("orders", null, 1));
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN aggregated state when coordinator is unreachable")
    void testGetAggregatedState_unreachableCoordinator_returnsUnknown() {
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("orders");

        assertNotNull(state);
        assertEquals("orders", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should not throw when serviceName is null (and returns fallback on failure)")
    void testGetAggregatedState_nullServiceName_returnsFallback() {
        DistributedCircuitBreakerClient.AggregatedState state =
                assertDoesNotThrow(() -> client.getAggregatedState(null));

        assertNotNull(state);
        // service may be null depending on implementation; fallback fields should be stable
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("AggregatedState record should store and expose provided values")
    void testAggregatedState_recordStoresValues() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.75);

        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_idempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }

    @Test
    @DisplayName("shutdown should not prevent getBreaker from returning cached breaker")
    void testShutdown_thenGetBreaker_stillWorks() {
        CircuitBreaker<Object> before = client.getBreaker("orders");
        client.shutdown();
        CircuitBreaker<Object> after = client.getBreaker("orders");
        assertSame(before, after);
    }
}