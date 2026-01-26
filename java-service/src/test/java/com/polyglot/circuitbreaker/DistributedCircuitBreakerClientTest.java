package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private com.sun.net.httpserver.HttpServer server;
    private String baseUrl;
    private DistributedCircuitBreakerClient client;

    private java.util.concurrent.atomic.AtomicReference<String> lastPath;
    private java.util.concurrent.atomic.AtomicReference<String> lastMethod;
    private java.util.concurrent.atomic.AtomicReference<String> lastBody;
    private java.util.concurrent.atomic.AtomicInteger registerCount;
    private java.util.concurrent.atomic.AtomicInteger stateCount;
    private java.util.concurrent.atomic.AtomicInteger aggregateCount;
    private java.util.concurrent.atomic.AtomicReference<String> aggregateResponseJson;

    @BeforeEach
    void setUp() throws Exception {
        lastPath = new java.util.concurrent.atomic.AtomicReference<>("");
        lastMethod = new java.util.concurrent.atomic.AtomicReference<>("");
        lastBody = new java.util.concurrent.atomic.AtomicReference<>("");
        registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
        stateCount = new java.util.concurrent.atomic.AtomicInteger(0);
        aggregateCount = new java.util.concurrent.atomic.AtomicInteger(0);
        aggregateResponseJson = new java.util.concurrent.atomic.AtomicReference<>(
            "{\"service\":\"default\",\"consensus_state\":\"CLOSED\",\"total_nodes\":1,\"health_score\":1.0}"
        );

        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new com.sun.net.httpserver.HttpHandler() {
            @Override
            public void handle(com.sun.net.httpserver.HttpExchange exchange) throws java.io.IOException {
                String method = exchange.getRequestMethod();
                String path = exchange.getRequestURI().getPath();
                lastMethod.set(method);
                lastPath.set(path);

                String requestBody = "";
                if ("POST".equalsIgnoreCase(method)) {
                    byte[] bytes = exchange.getRequestBody().readAllBytes();
                    requestBody = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                    lastBody.set(requestBody);
                }

                byte[] response;
                int status = 200;

                if (path.endsWith("/circuit-breakers/register") && "POST".equalsIgnoreCase(method)) {
                    registerCount.incrementAndGet();
                    response = "registered".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                } else if (path.endsWith("/circuit-breakers/state") && "POST".equalsIgnoreCase(method)) {
                    stateCount.incrementAndGet();
                    response = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                } else if (path.contains("/circuit-breakers/") && path.endsWith("/aggregate") && "GET".equalsIgnoreCase(method)) {
                    aggregateCount.incrementAndGet();
                    String json = aggregateResponseJson.get();
                    response = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                } else {
                    status = 404;
                    response = "not-found".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                }

                exchange.sendResponseHeaders(status, response.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(response);
                }
            }
        });
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
        int port = server.getAddress().getPort();
        baseUrl = "http://127.0.0.1:" + port;

        client = new DistributedCircuitBreakerClient(baseUrl);
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
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should return same instance for the same service")
    void testGetBreaker_ReturnsSameInstanceForSameService() {
        Object b1 = client.getBreaker("svcA");
        Object b2 = client.getBreaker("svcA");
        assertNotNull(b1);
        assertSame(b1, b2);

        assertEquals(1, registerCount.get(), "register should be called only once for the same service");
        assertEquals("/circuit-breakers/register", lastPath.get());
        assertTrue(lastBody.get().contains("\"service\":\"svcA\""), "register payload should contain the service name");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different services and register each once")
    void testGetBreaker_DifferentServicesDifferentInstances() {
        Object a = client.getBreaker("svcA");
        Object b = client.getBreaker("svcB");
        assertNotSame(a, b);
        assertEquals(2, registerCount.get(), "register should be called for each distinct service");
        assertTrue(lastBody.get().contains("\"service\":\"svcB\""), "last register payload should be for svcB");
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException for null service name")
    void testGetBreaker_NullServiceName_Throws() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should POST asynchronously to coordinator with correct payload")
    void testReportState_PostsAsyncPayload() throws Exception {
        // Reset last observed request details
        lastPath.set("");
        lastMethod.set("");
        lastBody.set("");
        int before = stateCount.get();

        client.reportState("payment", com.polyglot.circuitbreaker.CircuitBreaker.State.OPEN, 7);

        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < 2000 && stateCount.get() == before) {
            try { Thread.sleep(25); } catch (InterruptedException ignored) {}
        }

        assertTrue(stateCount.get() > before, "state endpoint should have been called");
        assertEquals("/circuit-breakers/state", lastPath.get());
        assertEquals("POST", lastMethod.get());
        String body = lastBody.get();
        assertTrue(body.contains("\"service\":\"payment\""));
        assertTrue(body.contains("\"state\":\"OPEN\""));
        assertTrue(body.contains("\"failure_count\":7"));
        assertTrue(body.contains("\"timestamp\":"), "payload should include timestamp");
    }

    @Test
    @DisplayName("getAggregatedState should return parsed values on successful response")
    void testGetAggregatedState_ReturnsParsedValuesOnSuccess() {
        aggregateResponseJson.set("{\"service\":\"orders\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.42}");

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("orders");

        assertNotNull(agg);
        assertEquals("orders", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.42, agg.healthScore(), 0.000001);
        assertEquals("/circuit-breakers/orders/aggregate", lastPath.get());
        assertEquals(1, aggregateCount.get());
    }

    @Test
    @DisplayName("getAggregatedState should return defaults when coordinator call fails")
    void testGetAggregatedState_ReturnsFallbackOnError() {
        DistributedCircuitBreakerClient failingClient = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = failingClient.getAggregatedState("inventory");
            assertNotNull(agg);
            assertEquals("inventory", agg.service());
            assertEquals("UNKNOWN", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.000001);
        } finally {
            failingClient.shutdown();
        }
    }

    @Test
    @DisplayName("getAggregatedState should handle missing keys by returning default values")
    void testGetAggregatedState_ParsesMissingKeysToDefaults() {
        aggregateResponseJson.set("{\"service\":\"svcZ\"}");

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("ignored");

        assertNotNull(agg);
        assertEquals("svcZ", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        client.shutdown();
        assertDoesNotThrow(() -> client.shutdown());
    }
}