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
        // Use an unreachable coordinator URL to avoid real network calls
        client = new DistributedCircuitBreakerClient("http://invalid.localhost");
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            client.shutdown();
        }
        client = null;
    }

    @Test
    @DisplayName("Constructor should create instance and start without throwing")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache and return same instance for same service")
    void testGetBreaker_CachesPerService() {
        CircuitBreaker<Object> b1 = client.getBreaker("svcA");
        CircuitBreaker<Object> b2 = client.getBreaker("svcA");
        CircuitBreaker<Object> b3 = client.getBreaker("svcB");

        assertNotNull(b1);
        assertNotNull(b2);
        assertNotNull(b3);

        assertSame(b1, b2, "Expected same breaker instance for same service name");
        assertNotSame(b1, b3, "Expected different breaker instances for different service names");
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException when service name is null")
    void testGetBreaker_NullService_Throws() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should not throw even if coordinator is unreachable")
    void testReportState_NoThrowOnNetworkError() {
        // Ensure a breaker exists to simulate real usage
        client.getBreaker("payments");
        // Should not throw
        assertDoesNotThrow(() ->
            client.reportState("payments", CircuitBreaker.State.CLOSED, 0)
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on network error")
    void testGetAggregatedState_FallbackOnError() {
        String service = "inventory";
        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState(service);

        assertNotNull(agg);
        assertEquals(service, agg.service());
        assertEquals("UNKNOWN", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON response correctly")
    void testGetAggregatedState_ParseValidJson() throws Exception {
        // Start a simple in-memory HTTP server to return a valid JSON response
        com.sun.net.httpserver.HttpServer server =
                com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        int port = server.getAddress().getPort();

        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/circuit-breakers/payments/aggregate")) {
                String json = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":3,\"health_score\":0.67}";
                byte[] bytes = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            } else {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
            }
        });
        server.start();

        DistributedCircuitBreakerClient localClient = new DistributedCircuitBreakerClient("http://127.0.0.1:" + port);
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = localClient.getAggregatedState("payments");
            assertNotNull(agg);
            assertEquals("payments", agg.service());
            assertEquals("OPEN", agg.consensusState());
            assertEquals(3, agg.totalNodes());
            assertEquals(0.67, agg.healthScore(), 0.000001);
        } finally {
            localClient.shutdown();
            server.stop(0);
        }
    }

    @Test
    @DisplayName("getAggregatedState should handle incomplete JSON gracefully")
    void testGetAggregatedState_IncompleteJson() throws Exception {
        com.sun.net.httpserver.HttpServer server =
                com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        int port = server.getAddress().getPort();

        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/circuit-breakers/alpha/aggregate")) {
                String json = "{}";
                byte[] bytes = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            } else {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
            }
        });
        server.start();

        DistributedCircuitBreakerClient localClient = new DistributedCircuitBreakerClient("http://127.0.0.1:" + port);
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = localClient.getAggregatedState("alpha");
            assertNotNull(agg);
            // Because parsing uses the response JSON fields, missing keys yield defaults
            assertEquals("", agg.service());
            assertEquals("", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.000001);
        } finally {
            localClient.shutdown();
            server.stop(0);
        }
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw on multiple calls")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }

    @Test
    @DisplayName("AggregatedState record should expose values correctly")
    void testAggregatedStateRecord() {
        DistributedCircuitBreakerClient.AggregatedState state =
                new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 5, 0.95);

        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.95, state.healthScore(), 0.000001);
    }
}