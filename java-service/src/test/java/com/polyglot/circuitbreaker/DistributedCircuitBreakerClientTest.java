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
    private volatile String lastRegisterBody;
    private volatile String lastStateBody;

    @BeforeEach
    void setUp() throws Exception {
        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("localhost", 0), 0);

        // /circuit-breakers/register handler
        server.createContext("/circuit-breakers/register", exchange -> {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                registerCount.incrementAndGet();
                byte[] req = exchange.getRequestBody().readAllBytes();
                lastRegisterBody = new String(req, java.nio.charset.StandardCharsets.UTF_8);
                byte[] resp = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/plain");
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
            }
        });

        // /circuit-breakers/state handler
        server.createContext("/circuit-breakers/state", exchange -> {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                stateCount.incrementAndGet();
                byte[] req = exchange.getRequestBody().readAllBytes();
                lastStateBody = new String(req, java.nio.charset.StandardCharsets.UTF_8);
                byte[] resp = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/plain");
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
            }
        });

        // /circuit-breakers/test-service/aggregate handler (valid JSON)
        server.createContext("/circuit-breakers/test-service/aggregate", exchange -> {
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                String json = "{\"service\":\"test-service\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.6}";
                byte[] resp = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
            }
        });

        // /circuit-breakers/malformed/aggregate handler (malformed/missing keys)
        server.createContext("/circuit-breakers/malformed/aggregate", exchange -> {
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                String json = "{\"unexpected\":\"value\"}";
                byte[] resp = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
            }
        });

        server.start();
        int port = server.getAddress().getPort();
        baseUrl = "http://localhost:" + port;
        client = new DistributedCircuitBreakerClient(baseUrl);
    }

    @AfterEach
    void tearDown() {
        try {
            if (client != null) {
                client.shutdown();
            }
        } finally {
            if (server != null) {
                server.stop(0);
            }
        }
        client = null;
        server = null;
        lastRegisterBody = null;
        lastStateBody = null;
        registerCount.set(0);
        stateCount.set(0);
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache same instance per service and register once")
    void testGetBreaker_CachingAndRegistration() {
        CircuitBreaker<Object> b1 = client.getBreaker("serviceA");
        CircuitBreaker<Object> b2 = client.getBreaker("serviceA");
        CircuitBreaker<Object> b3 = client.getBreaker("serviceB");

        assertSame(b1, b2, "Expected same breaker instance for same service");
        assertNotSame(b1, b3, "Expected different breaker instances for different services");

        // Registration should occur once per unique service on first creation
        assertEquals(2, registerCount.get(), "Expected registration for two distinct services");

        // Body should include mandatory fields
        assertNotNull(lastRegisterBody);
        assertTrue(lastRegisterBody.contains("\"service\":\"serviceB\"") || lastRegisterBody.contains("\"service\":\"serviceA\""));
        assertTrue(lastRegisterBody.contains("\"node_id\":\""), "Expected node_id field in registration JSON");
        assertTrue(lastRegisterBody.contains("\"failure_threshold\":5"), "Expected failure_threshold in registration JSON");
        assertTrue(lastRegisterBody.contains("\"success_threshold\":3"), "Expected success_threshold in registration JSON");
    }

    @Test
    @DisplayName("reportState should POST asynchronously without throwing and reach server")
    void testReportState_DoesNotThrowAndPosts() throws Exception {
        client.reportState("svcX", CircuitBreaker.State.CLOSED, 1);

        boolean delivered = waitForCondition(() -> stateCount.get() >= 1, 3000);
        assertTrue(delivered, "Expected at least one state report to be received by server");

        assertNotNull(lastStateBody, "Expected state body to be captured");
        assertTrue(lastStateBody.contains("\"service\":\"svcX\""));
        assertTrue(lastStateBody.contains("\"state\":\"CLOSED\""));
        assertTrue(lastStateBody.contains("\"failure_count\":1"));
        assertTrue(lastStateBody.contains("\"timestamp\":"), "Expected timestamp field in state JSON");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON response")
    void testGetAggregatedState_ParsesValidJson() {
        DistributedCircuitBreakerClient.AggregatedState agg =
                client.getAggregatedState("test-service");

        assertNotNull(agg);
        assertEquals("test-service", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.6, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should handle malformed JSON by returning defaults from parser")
    void testGetAggregatedState_MalformedJsonHandled() {
        DistributedCircuitBreakerClient.AggregatedState agg =
                client.getAggregatedState("malformed");

        assertNotNull(agg);
        // Parser returns empty string and zeros when keys are missing (on successful HTTP)
        assertEquals("", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on HTTP error")
    void testGetAggregatedState_UnknownOnHttpError() {
        DistributedCircuitBreakerClient badClient =
                new DistributedCircuitBreakerClient("http://127.0.0.1:1"); // closed port likely causes error

        DistributedCircuitBreakerClient.AggregatedState agg =
                badClient.getAggregatedState("no-server");

        assertNotNull(agg);
        assertEquals("no-server", agg.service());
        assertEquals("UNKNOWN", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0001);

        badClient.shutdown();
    }

    @Test
    @DisplayName("Background sync thread should periodically report state and stop after shutdown")
    void testSyncThread_PeriodicReportAndShutdownStops() throws Exception {
        // Create a breaker so it is included in periodic sync
        client.getBreaker("svcSync");

        int initialStateReports = stateCount.get();

        boolean firstReport = waitForCondition(() -> stateCount.get() > initialStateReports, 7000);
        assertTrue(firstReport, "Expected at least one periodic state report before shutdown");

        // Shutdown client and allow any in-flight report to complete
        client.shutdown();
        Thread.sleep(1000);
        int settledAfterShutdown = stateCount.get();

        // Wait longer than sync interval to ensure no further periodic reports after shutdown
        Thread.sleep(6000);
        int finalAfterShutdown = stateCount.get();

        assertEquals(settledAfterShutdown, finalAfterShutdown, "No periodic reports should be sent after shutdown");
    }

    @Test
    @DisplayName("shutdown should be idempotent")
    void testShutdown_Idempotent() {
        client.shutdown();
        assertDoesNotThrow(() -> client.shutdown());
    }

    // Helper: wait for condition up to timeoutMillis
    private boolean waitForCondition(java.util.concurrent.Callable<Boolean> condition, long timeoutMillis) throws Exception {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < timeoutMillis) {
            if (condition.call()) return true;
            Thread.sleep(50);
        }
        return false;
    }
}