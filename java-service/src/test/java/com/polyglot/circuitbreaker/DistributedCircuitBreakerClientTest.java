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
        // Use an unreachable coordinator to avoid real network calls; methods under test handle exceptions internally
        client = new DistributedCircuitBreakerClient("http://localhost:65535");
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
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache and return same instance for same service name")
    void testGetBreaker_CachesByName() {
        CircuitBreaker<Object> b1 = client.getBreaker("service-A");
        CircuitBreaker<Object> b2 = client.getBreaker("service-A");
        assertNotNull(b1);
        assertNotNull(b2);
        assertSame(b1, b2, "Expected same CircuitBreaker instance for same service name");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreaker_DifferentNamesDifferentInstances() {
        CircuitBreaker<Object> b1 = client.getBreaker("service-A");
        CircuitBreaker<Object> b2 = client.getBreaker("service-B");
        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2, "Expected different CircuitBreaker instances for different service names");
    }

    @Test
    @DisplayName("reportState should not throw even if coordinator is unreachable")
    void testReportState_NoThrowOnNetworkError() {
        CircuitBreaker<Object> breaker = client.getBreaker("orders");
        assertDoesNotThrow(() -> client.reportState("orders", breaker.getState(), breaker.getFailureCount()));
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN and defaults when coordinator is unreachable")
    void testGetAggregatedState_DefaultsOnError() {
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("payments");
        assertNotNull(state);
        assertEquals("payments", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("parseAggregatedState should parse valid JSON correctly")
    void testParseAggregatedState_ValidJson() throws Exception {
        String json = "{\"service\":\"orders\",\"consensus_state\":\"OPEN\",\"total_nodes\":7,\"health_score\":0.42}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("parseAggregatedState", String.class);
        m.setAccessible(true);
        Object result = m.invoke(client, json);
        assertTrue(result instanceof DistributedCircuitBreakerClient.AggregatedState);
        DistributedCircuitBreakerClient.AggregatedState as = (DistributedCircuitBreakerClient.AggregatedState) result;
        assertEquals("orders", as.service());
        assertEquals("OPEN", as.consensusState());
        assertEquals(7, as.totalNodes());
        assertEquals(0.42, as.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("parseAggregatedState should handle missing fields gracefully")
    void testParseAggregatedState_MissingFields() throws Exception {
        String json = "{}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("parseAggregatedState", String.class);
        m.setAccessible(true);
        DistributedCircuitBreakerClient.AggregatedState as =
                (DistributedCircuitBreakerClient.AggregatedState) m.invoke(client, json);
        assertEquals("", as.service());
        assertEquals("", as.consensusState());
        assertEquals(0, as.totalNodes());
        assertEquals(0.0, as.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("extractJsonString should return value for present key")
    void testExtractJsonString_Present() throws Exception {
        String json = "{\"service\":\"inventory\"}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonString", String.class, String.class);
        m.setAccessible(true);
        String value = (String) m.invoke(client, json, "service");
        assertEquals("inventory", value);
    }

    @Test
    @DisplayName("extractJsonString should return empty string for missing key")
    void testExtractJsonString_Missing() throws Exception {
        String json = "{\"another\":\"value\"}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonString", String.class, String.class);
        m.setAccessible(true);
        String value = (String) m.invoke(client, json, "service");
        assertEquals("", value);
    }

    @Test
    @DisplayName("extractJsonInt should parse integer value")
    void testExtractJsonInt_Valid() throws Exception {
        String json = "{\"total_nodes\":12345}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonInt", String.class, String.class);
        m.setAccessible(true);
        int value = (Integer) m.invoke(client, json, "total_nodes");
        assertEquals(12345, value);
    }

    @Test
    @DisplayName("extractJsonInt should return 0 for malformed number")
    void testExtractJsonInt_Malformed() throws Exception {
        String json = "{\"total_nodes\":\"abc\"}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonInt", String.class, String.class);
        m.setAccessible(true);
        int value = (Integer) m.invoke(client, json, "total_nodes");
        assertEquals(0, value);
    }

    @Test
    @DisplayName("extractJsonDouble should parse double value")
    void testExtractJsonDouble_Valid() throws Exception {
        String json = "{\"health_score\":0.75}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonDouble", String.class, String.class);
        m.setAccessible(true);
        double value = (Double) m.invoke(client, json, "health_score");
        assertEquals(0.75, value, 0.0001);
    }

    @Test
    @DisplayName("extractJsonDouble should return 0.0 for negative or malformed number")
    void testExtractJsonDouble_NegativeOrMalformed() throws Exception {
        String jsonNegative = "{\"health_score\":-0.75}";
        String jsonMalformed = "{\"health_score\":\"x\"}";
        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonDouble", String.class, String.class);
        m.setAccessible(true);
        double valueNegative = (Double) m.invoke(client, jsonNegative, "health_score");
        double valueMalformed = (Double) m.invoke(client, jsonMalformed, "health_score");
        assertEquals(0.0, valueNegative, 0.0001);
        assertEquals(0.0, valueMalformed, 0.0001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> {
            client.shutdown();
            client.shutdown();
        });
    }

    @Test
    @DisplayName("AggregatedState record should expose provided values")
    void testAggregatedState_RecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.99);
        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.99, state.healthScore(), 0.0001);
    }
}