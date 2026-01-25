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
    private int port;

    private java.util.concurrent.atomic.AtomicInteger registerCount;
    private java.util.concurrent.atomic.AtomicInteger stateCount;
    private java.util.concurrent.ConcurrentHashMap<String, String> aggregateResponses;

    @BeforeEach
    void setUp() throws Exception {
        registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
        stateCount = new java.util.concurrent.atomic.AtomicInteger(0);
        aggregateResponses = new java.util.concurrent.ConcurrentHashMap<>();

        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);

        // Register endpoint
        server.createContext("/circuit-breakers/register", exchange -> {
            registerCount.incrementAndGet();
            // consume request body
            try (java.io.InputStream is = exchange.getRequestBody()) {
                while (is.read() != -1) { /* drain */ }
            } catch (Exception ignored) {}
            byte[] response = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // State reporting endpoint
        server.createContext("/circuit-breakers/state", exchange -> {
            stateCount.incrementAndGet();
            // consume request body
            try (java.io.InputStream is = exchange.getRequestBody()) {
                while (is.read() != -1) { /* drain */ }
            } catch (Exception ignored) {}
            byte[] response = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // Aggregate endpoint handler (catch-all for /circuit-breakers/{service}/aggregate)
        server.createContext("/circuit-breakers", exchange -> {
            String path = exchange.getRequestURI().getPath(); // e.g., /circuit-breakers/orders/aggregate
            String method = exchange.getRequestMethod();
            if ("GET".equalsIgnoreCase(method) && path != null && path.startsWith("/circuit-breakers/") && path.endsWith("/aggregate")) {
                String[] parts = path.split("/");
                String service = parts.length >= 4 ? parts[2] : "";
                String json = aggregateResponses.getOrDefault(service, "{\"service\":\"" + service + "\",\"consensus_state\":\"UNKNOWN\",\"total_nodes\":0,\"health_score\":0.0}");
                byte[] response = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, response.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(response);
                }
            } else {
                byte[] response = "not found".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(404, response.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(response);
                }
            }
        });

        server.start();
        port = server.getAddress().getPort();

        client = new DistributedCircuitBreakerClient("http://127.0.0.1:" + port);
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
    @DisplayName("Constructor should create instance and allow shutdown without errors")
    void testConstructorAndShutdown() {
        assertNotNull(client);
        // Idempotent shutdown
        client.shutdown();
        client.shutdown();
    }

    @Test
    @DisplayName("getBreaker should cache per service and register only on first creation")
    void testGetBreaker_CachesByName_RegistersOnce() {
        Object breaker1 = client.getBreaker("svc1");
        Object breaker1Again = client.getBreaker("svc1");
        Object breaker2 = client.getBreaker("svc2");

        assertNotNull(breaker1);
        assertSame(breaker1, breaker1Again, "Expected same breaker instance for same service name");
        assertNotSame(breaker1, breaker2, "Expected different breaker instance for different service name");

        assertEquals(2, registerCount.get(), "Expected one registration per distinct service");
    }

    @Test
    @DisplayName("Background sync should periodically report breaker state")
    void testBackgroundSync_ReportsStatePeriodically() throws Exception {
        client.getBreaker("sync-svc");

        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < deadline && stateCount.get() == 0) {
            Thread.sleep(100);
        }
        assertTrue(stateCount.get() > 0, "Expected at least one state report via background sync");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON from coordinator")
    void testGetAggregatedState_SuccessfulParsing() {
        String service = "orders";
        aggregateResponses.put(service, "{\"service\":\"orders\",\"consensus_state\":\"OPEN\",\"total_nodes\":3,\"health_score\":0.66}");

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState(service);
        assertNotNull(agg);
        assertEquals("orders", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(3, agg.totalNodes());
        assertEquals(0.66, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should handle missing fields gracefully (defaults from parser)")
    void testGetAggregatedState_InvalidJsonFields_ParsedDefaults() {
        String service = "empty";
        aggregateResponses.put(service, "{}");

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState(service);
        assertNotNull(agg);
        // parseAggregatedState returns extracted fields; missing string keys become "", numbers become 0 / 0.0
        assertEquals("", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on network failure")
    void testGetAggregatedState_NetworkFailure_ReturnsUnknown() {
        DistributedCircuitBreakerClient badClient = new DistributedCircuitBreakerClient("http://127.0.0.1:9");
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = badClient.getAggregatedState("nf-svc");
            assertNotNull(agg);
            assertEquals("nf-svc", agg.service());
            assertEquals("UNKNOWN", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.000001);
        } finally {
            badClient.shutdown();
        }
    }

    @Test
    @DisplayName("reportState should catch exceptions (e.g., null state) without throwing")
    void testReportState_NullState_DoesNotThrow() {
        assertDoesNotThrow(() -> client.reportState("svc-null", null, 10));
    }

    @Test
    @DisplayName("shutdown should stop further periodic state reports (allowing at most one in-flight)")
    void testShutdown_StopsBackgroundSync() throws Exception {
        client.getBreaker("shutdown-svc");

        // Wait for at least one report
        long firstDeadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < firstDeadline && stateCount.get() == 0) {
            Thread.sleep(100);
        }
        int beforeShutdownReports = stateCount.get();
        assertTrue(beforeShutdownReports > 0, "Expected at least one report before shutdown");

        client.shutdown();

        // Wait longer than sync interval to ensure no new reports are sent
        int reportsAtShutdown = stateCount.get();
        Thread.sleep(6000);
        int reportsAfter = stateCount.get();

        // Allow at most one in-flight report after shutdown due to scheduling races
        assertTrue(reportsAfter - reportsAtShutdown <= 1, "No additional reports should be sent after shutdown (at most one in-flight allowed)");
    }
}