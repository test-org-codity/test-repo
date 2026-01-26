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
        // Use an unreachable coordinator URL to avoid real network calls and trigger error paths safely
        client = new DistributedCircuitBreakerClient("http://127.0.0.1:65535");
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            client.shutdown();
            // Ensure idempotency
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
    @DisplayName("getBreaker should return same instance for same service name")
    void testGetBreaker_SameNameSameInstance() {
        CircuitBreaker<Object> b1 = client.getBreaker("serviceA");
        CircuitBreaker<Object> b2 = client.getBreaker("serviceA");
        assertSame(b1, b2);
    }

    @Test
    @DisplayName("getBreaker should return different instances for different service names")
    void testGetBreaker_DifferentNamesDifferentInstances() {
        CircuitBreaker<Object> b1 = client.getBreaker("serviceA");
        CircuitBreaker<Object> b2 = client.getBreaker("serviceB");
        assertNotSame(b1, b2);
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException for null service name")
    void testGetBreaker_NullName_Throws() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("getBreaker should be safe under concurrent access - single instance per name")
    void testGetBreaker_ConcurrentAccessSingleInstance() throws InterruptedException {
        final int threads = 20;
        final Object[] results = new Object[threads];
        final java.util.concurrent.CountDownLatch startLatch = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch doneLatch = new java.util.concurrent.CountDownLatch(threads);

        for (int i = 0; i < threads; i++) {
            final int idx = i;
            new Thread(() -> {
                try {
                    startLatch.await();
                    results[idx] = client.getBreaker("concurrentService");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    doneLatch.countDown();
                }
            }).start();
        }

        startLatch.countDown();
        boolean finished = doneLatch.await(3, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(finished, "Concurrent tasks did not finish in time");

        Object first = results[0];
        for (int i = 1; i < threads; i++) {
            assertSame(first, results[i], "Different instances returned under concurrency");
        }
    }

    @Test
    @DisplayName("reportState should not throw even when network fails (async path)")
    void testReportState_DoesNotThrowOnNetworkFailure() {
        assertDoesNotThrow(() ->
            client.reportState("orders", com.polyglot.circuitbreaker.CircuitBreaker.State.CLOSED, 0)
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on network error")
    void testGetAggregatedState_FallbackOnError() {
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("inventory");
        assertNotNull(state);
        assertEquals("inventory", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("AggregatedState record should expose provided values")
    void testAggregatedState_RecordAccessors() {
        DistributedCircuitBreakerClient.AggregatedState state =
            new DistributedCircuitBreakerClient.AggregatedState("billing", "OPEN", 3, 0.75);

        assertEquals("billing", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("parseAggregatedState should parse valid JSON correctly (via reflection)")
    void testParseAggregatedState_ValidJson() throws Exception {
        String json = "{\"service\":\"orders\",\"consensus_state\":\"OPEN\",\"total_nodes\":7,\"health_score\":0.85}";

        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class
            .getDeclaredMethod("parseAggregatedState", String.class);
        m.setAccessible(true);

        Object result = assertDoesNotThrow(() -> m.invoke(client, json));
        assertNotNull(result);
        assertTrue(result instanceof DistributedCircuitBreakerClient.AggregatedState);

        DistributedCircuitBreakerClient.AggregatedState state =
            (DistributedCircuitBreakerClient.AggregatedState) result;

        assertEquals("orders", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(7, state.totalNodes());
        assertEquals(0.85, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("JSON extractors should return defaults on missing or malformed fields (via reflection)")
    void testJsonExtractors_MissingOrMalformed() throws Exception {
        String jsonMissing = "{}";
        String jsonBadNumbers = "{\"total_nodes\":notANumber,\"health_score\":NaN}";

        // extractJsonString
        java.lang.reflect.Method extractString = DistributedCircuitBreakerClient.class
            .getDeclaredMethod("extractJsonString", String.class, String.class);
        extractString.setAccessible(true);
        String missingService = (String) assertDoesNotThrow(() -> extractString.invoke(client, jsonMissing, "service"));
        assertEquals("", missingService);

        // extractJsonInt
        java.lang.reflect.Method extractInt = DistributedCircuitBreakerClient.class
            .getDeclaredMethod("extractJsonInt", String.class, String.class);
        extractInt.setAccessible(true);
        int badInt = (int) assertDoesNotThrow(() -> extractInt.invoke(client, jsonBadNumbers, "total_nodes"));
        assertEquals(0, badInt);

        // extractJsonDouble
        java.lang.reflect.Method extractDouble = DistributedCircuitBreakerClient.class
            .getDeclaredMethod("extractJsonDouble", String.class, String.class);
        extractDouble.setAccessible(true);
        double badDouble = (double) assertDoesNotThrow(() -> extractDouble.invoke(client, jsonBadNumbers, "health_score"));
        assertEquals(0.0, badDouble, 0.0001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> {
            client.shutdown();
            client.shutdown();
        });
    }
}