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

    private java.util.concurrent.atomic.AtomicInteger registerCount;
    private java.util.concurrent.atomic.AtomicInteger stateReportCount;

    @BeforeEach
    void setUp() throws Exception {
        registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
        stateReportCount = new java.util.concurrent.atomic.AtomicInteger(0);

        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);

        // Registration endpoint
        server.createContext("/circuit-breakers/register", exchange -> {
            registerCount.incrementAndGet();
            byte[] response = "OK".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // State report endpoint
        server.createContext("/circuit-breakers/state", exchange -> {
            stateReportCount.incrementAndGet();
            byte[] response = "ACCEPTED".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(202, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // Aggregated state: valid JSON
        server.createContext("/circuit-breakers/test-service/aggregate", exchange -> {
            String json = "{\"service\":\"test-service\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.75}";
            byte[] response = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // Aggregated state: malformed numbers
        server.createContext("/circuit-breakers/bad-json/aggregate", exchange -> {
            String json = "{\"service\":\"bad-json\",\"consensus_state\":\"CLOSED\",\"total_nodes\":\"oops\",\"health_score\":\"xyz\"}";
            byte[] response = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (java.io.OutputStream os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        server.start();
        int port = server.getAddress().getPort();
        baseUrl = "http://127.0.0.1:" + port;

        client = new DistributedCircuitBreakerClient(baseUrl);
    }

    @AfterEach
    void tearDown() {
        if (client != null) {
            client.shutdown();
            client = null;
        }
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    @Test
    @DisplayName("Constructor creates instance and sync thread starts")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should register once and cache instance by name")
    void testGetBreaker_RegistersOnceAndCaches() {
        Object breaker1 = client.getBreaker("svc1");
        assertNotNull(breaker1);
        assertEquals(1, registerCount.get(), "First getBreaker should register once");

        Object breaker2 = client.getBreaker("svc1");
        assertSame(breaker1, breaker2, "Breaker should be cached per service name");
        assertEquals(1, registerCount.get(), "Second getBreaker for same name should not re-register");
    }

    @Test
    @DisplayName("getBreaker should return different instances for different names")
    void testGetBreaker_DifferentNamesDifferentInstances() {
        Object a = client.getBreaker("serviceA");
        Object b = client.getBreaker("serviceB");
        assertNotNull(a);
        assertNotNull(b);
        assertNotSame(a, b);
        assertEquals(2, registerCount.get(), "Both services should be registered once each");
    }

    @Test
    @DisplayName("reportState should POST asynchronously without throwing")
    void testReportState_AsynchronousNoThrow() {
        // Call multiple times
        client.reportState("svcX", CircuitBreaker.State.CLOSED, 1);
        client.reportState("svcX", CircuitBreaker.State.OPEN, 2);
        client.reportState("svcX", CircuitBreaker.State.HALF_OPEN, 3);

        // Give a brief moment for async HTTP to reach server
        try {
            Thread.sleep(200);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("Test interrupted");
        }

        assertTrue(stateReportCount.get() >= 3, "Expected at least 3 state reports");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid coordinator JSON")
    void testGetAggregatedState_ParsesValidJson() {
        DistributedCircuitBreakerClient.AggregatedState agg =
            client.getAggregatedState("test-service");

        assertNotNull(agg);
        assertEquals("test-service", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.75, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should handle malformed numeric fields gracefully")
    void testGetAggregatedState_MalformedNumbers() {
        DistributedCircuitBreakerClient.AggregatedState agg =
            client.getAggregatedState("bad-json");

        assertNotNull(agg);
        assertEquals("bad-json", agg.service());
        assertEquals("CLOSED", agg.consensusState());
        assertEquals(0, agg.totalNodes(), "Malformed int should default to 0");
        assertEquals(0.0, agg.healthScore(), 0.000001, "Malformed double should default to 0.0");
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on coordinator failure")
    void testGetAggregatedState_FailureFallback() {
        // Replace client with one pointing to an invalid host
        if (client != null) client.shutdown();
        client = new DistributedCircuitBreakerClient("http://nonexistent.invalid");

        DistributedCircuitBreakerClient.AggregatedState agg =
            client.getAggregatedState("missing-service");

        assertNotNull(agg);
        assertEquals("missing-service", agg.service());
        assertEquals("UNKNOWN", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("shutdown should stop periodic synchronization reports")
    void testShutdown_StopsPeriodicSync() {
        // Ensure a breaker exists so sync thread would have something to report
        client.getBreaker("sync-service");

        // Reset state counter just in case
        stateReportCount.set(0);

        // Shutdown immediately to prevent any cycle from reporting
        client.shutdown();

        // Wait longer than the sync interval (5 seconds) to ensure no reports happen
        try {
            Thread.sleep(5500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("Test interrupted");
        }

        assertEquals(0, stateReportCount.get(), "No periodic reports should occur after shutdown");
    }
}