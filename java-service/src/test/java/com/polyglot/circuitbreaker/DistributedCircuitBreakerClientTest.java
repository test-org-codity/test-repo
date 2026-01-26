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

    // Embedded HTTP server and helpers
    private com.sun.net.httpserver.HttpServer server;
    private String baseUrl;

    private final java.util.concurrent.atomic.AtomicInteger registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicInteger stateCount = new java.util.concurrent.atomic.AtomicInteger(0);

    // Aggregate response controls
    private volatile String aggConsensusState = "CLOSED";
    private volatile int aggTotalNodes = 1;
    private volatile double aggHealthScore = 1.0;
    private volatile boolean respondWithMalformedAggregate = false;

    @BeforeEach
    void setUp() throws Exception {
        java.net.InetSocketAddress addr = new java.net.InetSocketAddress("127.0.0.1", 0);
        server = com.sun.net.httpserver.HttpServer.create(addr, 0);
        server.createContext("/", exchange -> {
            try {
                String path = exchange.getRequestURI().getPath();
                String method = exchange.getRequestMethod();

                // Read request body to completion to support keep-alive
                byte[] requestBody = exchange.getRequestBody().readAllBytes();

                if ("/circuit-breakers/register".equals(path) && "POST".equalsIgnoreCase(method)) {
                    registerCount.incrementAndGet();
                    byte[] response = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                } else if ("/circuit-breakers/state".equals(path) && "POST".equalsIgnoreCase(method)) {
                    stateCount.incrementAndGet();
                    byte[] response = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                } else if (path.startsWith("/circuit-breakers/") && path.endsWith("/aggregate") && "GET".equalsIgnoreCase(method)) {
                    String[] parts = path.split("/");
                    String service = parts.length >= 4 ? parts[2] : "";
                    byte[] response;
                    if (respondWithMalformedAggregate) {
                        response = "not-json".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    } else {
                        String json = "{\"service\":\"" + service + "\","
                            + "\"consensus_state\":\"" + aggConsensusState + "\","
                            + "\"total_nodes\":" + aggTotalNodes + ","
                            + "\"health_score\":" + Double.toString(aggHealthScore) + "}";
                        response = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    }
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                } else {
                    byte[] response = "not-found".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(404, response.length);
                    exchange.getResponseBody().write(response);
                }
            } finally {
                try { exchange.close(); } catch (Exception ignored) {}
            }
        });
        server.start();
        int port = server.getAddress().getPort();
        baseUrl = "http://127.0.0.1:" + port;

        // Fresh client for each test
        client = new DistributedCircuitBreakerClient(baseUrl);

        // Reset counters/config
        registerCount.set(0);
        stateCount.set(0);
        aggConsensusState = "CLOSED";
        aggTotalNodes = 1;
        aggHealthScore = 1.0;
        respondWithMalformedAggregate = false;
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            client.shutdown();
        }
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("Should create client instance successfully")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache instance per service and register only once")
    void testGetBreaker_CacheAndRegisterOnce() {
        CircuitBreaker<Object> b1 = client.getBreaker("svcA");
        assertNotNull(b1);

        CircuitBreaker<Object> b2 = client.getBreaker("svcA");
        assertSame(b1, b2, "Expected same breaker instance for same service");

        assertEquals(1, registerCount.get(), "Expected exactly one registration call for a single service");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different services and register each")
    void testGetBreaker_DifferentServices() {
        CircuitBreaker<Object> b1 = client.getBreaker("svcA");
        CircuitBreaker<Object> b2 = client.getBreaker("svcB");

        assertNotSame(b1, b2, "Expected different breaker instances for different services");
        assertEquals(2, registerCount.get(), "Expected one registration call per distinct service");
    }

    @Test
    @DisplayName("reportState should send asynchronously without throwing and hit endpoint")
    void testReportState_SendsAsync() throws Exception {
        int before = stateCount.get();
        client.reportState("svcA", CircuitBreaker.State.CLOSED, 7);

        // Await async increment
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < 2000 && stateCount.get() == before) {
            Thread.sleep(10);
        }
        assertTrue(stateCount.get() >= before + 1, "Expected state endpoint to be called at least once");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON response")
    void testGetAggregatedState_ParsesValidResponse() {
        aggConsensusState = "OPEN";
        aggTotalNodes = 5;
        aggHealthScore = 0.78;

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("payments");

        assertNotNull(agg);
        assertEquals("payments", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.78, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on coordinator error")
    void testGetAggregatedState_ReturnsUnknownOnError() {
        DistributedCircuitBreakerClient offlineClient = new DistributedCircuitBreakerClient("http://127.0.0.1:0");
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = offlineClient.getAggregatedState("nope");
            assertNotNull(agg);
            assertEquals("nope", agg.service());
            assertEquals("UNKNOWN", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.000001);
        } finally {
            offlineClient.shutdown();
        }
    }

    @Test
    @DisplayName("getAggregatedState should handle malformed JSON gracefully")
    void testGetAggregatedState_MalformedJson() {
        respondWithMalformedAggregate = true;

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("svcZ");

        assertNotNull(agg);
        // With malformed JSON, parser returns defaults for missing/invalid fields
        assertEquals("", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.000001);
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