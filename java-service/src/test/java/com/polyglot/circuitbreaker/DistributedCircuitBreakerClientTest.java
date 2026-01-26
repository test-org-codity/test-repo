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
    private com.sun.net.httpserver.HttpServer server;
    private String baseUrl;
    private final java.util.concurrent.atomic.AtomicInteger registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicInteger stateCount = new java.util.concurrent.atomic.AtomicInteger(0);
    private volatile String aggregateJson;

    @BeforeEach
    void setUp() throws Exception {
        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(0), 0);
        server.createContext("/circuit-breakers", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if ("POST".equalsIgnoreCase(method) && path.endsWith("/register")) {
                registerCount.incrementAndGet();
                try (java.io.InputStream is = exchange.getRequestBody()) {
                    while (is.read() != -1) { /* consume */ }
                }
                byte[] resp = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else if ("POST".equalsIgnoreCase(method) && path.endsWith("/state")) {
                stateCount.incrementAndGet();
                try (java.io.InputStream is = exchange.getRequestBody()) {
                    while (is.read() != -1) { /* consume */ }
                }
                byte[] resp = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else if ("GET".equalsIgnoreCase(method) && path.contains("/aggregate")) {
                byte[] resp = (aggregateJson == null ? "{}" : aggregateJson)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
            }
        });
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
        baseUrl = "http://localhost:" + server.getAddress().getPort();
        aggregateJson = "{\"service\":\"default\",\"consensus_state\":\"CLOSED\",\"total_nodes\":1,\"health_score\":1.0}";
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

    private void awaitCondition(java.util.function.BooleanSupplier condition, long timeoutMillis) throws InterruptedException {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < timeoutMillis) {
            if (condition.getAsBoolean()) return;
            Thread.sleep(20);
        }
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should return same instance for same service and register once")
    void testGetBreaker_SameInstanceAndRegisters() {
        CircuitBreaker<Object> b1 = client.getBreaker("payments");
        CircuitBreaker<Object> b2 = client.getBreaker("payments");
        assertNotNull(b1);
        assertSame(b1, b2);
        assertEquals(1, registerCount.get(), "Expected single registration on first creation");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different services and register separately")
    void testGetBreaker_DifferentNamesDifferentInstances() {
        CircuitBreaker<Object> b1 = client.getBreaker("s1");
        CircuitBreaker<Object> b2 = client.getBreaker("s2");
        assertNotNull(b1);
        assertNotNull(b2);
        assertNotSame(b1, b2);
        assertEquals(2, registerCount.get(), "Expected registration for each distinct service");
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException for null service name")
    void testGetBreaker_NullNameThrows() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("getBreaker should allow empty service name and register")
    void testGetBreaker_EmptyNameAllowed() {
        CircuitBreaker<Object> b = client.getBreaker("");
        assertNotNull(b);
        assertEquals(1, registerCount.get());
    }

    @Test
    @DisplayName("Breaker initial state should be non-null and failure count should be non-negative")
    void testBreakerInitialStateAndFailureCount() {
        CircuitBreaker<Object> b = client.getBreaker("init-check");
        assertNotNull(b.getState());
        assertTrue(b.getFailureCount() >= 0);
    }

    @Test
    @DisplayName("reportState should not throw and should send asynchronously")
    void testReportState_NoThrowAndAsyncSend() throws Exception {
        CircuitBreaker<Object> b = client.getBreaker("report-svc");
        int before = stateCount.get();
        client.reportState("report-svc", b.getState(), b.getFailureCount());
        awaitCondition(() -> stateCount.get() > before, 2000);
        assertTrue(stateCount.get() > before, "Expected at least one state report received by server");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON correctly")
    void testGetAggregatedState_ParsesFields() {
        aggregateJson = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.75}";
        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("payments");
        assertEquals("payments", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.75, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should gracefully handle malformed/missing JSON fields")
    void testGetAggregatedState_MalformedJson_Defaults() {
        aggregateJson = "{\"foo\":1}";
        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("svcX");
        assertEquals("", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on coordinator failure")
    void testGetAggregatedState_ServerFailure_ReturnsUnknown() {
        DistributedCircuitBreakerClient failing = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = failing.getAggregatedState("broken");
            assertEquals("broken", agg.service());
            assertEquals("UNKNOWN", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.0001);
        } finally {
            failing.shutdown();
        }
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        client.shutdown();
        client.shutdown();
        assertTrue(true, "No exception thrown on repeated shutdown");
    }
}