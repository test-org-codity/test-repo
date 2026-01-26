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

    // Captured request details
    private volatile int registerCount;
    private volatile String lastRegisterBody;
    private volatile String lastRegisterMethod;

    private volatile int stateCount;
    private volatile String lastStateBody;
    private volatile String lastStateMethod;

    private volatile String aggregateResponseJson;

    private java.util.concurrent.CountDownLatch registerLatch;
    private java.util.concurrent.CountDownLatch stateLatch;

    @BeforeEach
    void setUp() throws Exception {
        registerCount = 0;
        stateCount = 0;
        lastRegisterBody = null;
        lastRegisterMethod = null;
        lastStateBody = null;
        lastStateMethod = null;
        aggregateResponseJson = "";

        registerLatch = new java.util.concurrent.CountDownLatch(1);
        stateLatch = new java.util.concurrent.CountDownLatch(1);

        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/circuit-breakers", new com.sun.net.httpserver.HttpHandler() {
            @Override
            public void handle(com.sun.net.httpserver.HttpExchange exchange) throws java.io.IOException {
                String path = exchange.getRequestURI().getPath();
                String method = exchange.getRequestMethod();
                byte[] reqBodyBytes = exchange.getRequestBody().readAllBytes();
                String reqBody = new String(reqBodyBytes);

                byte[] responseBytes;
                int status = 200;

                if (path.equals("/circuit-breakers/register")) {
                    registerCount++;
                    lastRegisterMethod = method;
                    lastRegisterBody = reqBody;
                    registerLatch.countDown();
                    responseBytes = "{}".getBytes();
                } else if (path.equals("/circuit-breakers/state")) {
                    stateCount++;
                    lastStateMethod = method;
                    lastStateBody = reqBody;
                    stateLatch.countDown();
                    responseBytes = "{}".getBytes();
                } else if (path.endsWith("/aggregate")) {
                    String resp = aggregateResponseJson != null ? aggregateResponseJson : "{}";
                    responseBytes = resp.getBytes();
                } else {
                    status = 404;
                    responseBytes = "not found".getBytes();
                }

                exchange.sendResponseHeaders(status, responseBytes.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(responseBytes);
                }
                exchange.close();
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
        }
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("Constructor should create instance and start without exceptions")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should memoize per service and trigger single registration per new service")
    void testGetBreakerMemoizationAndRegistration() throws Exception {
        DistributedCircuitBreakerClient c = client;

        var b1 = c.getBreaker("alpha");
        assertNotNull(b1);

        // Wait for the registration POST to be received
        assertTrue(registerLatch.await(2, java.util.concurrent.TimeUnit.SECONDS), "Register request not received");
        assertEquals(1, registerCount, "Expected 1 register call after first getBreaker");

        // Same service should return same instance and not trigger another register
        var b2 = c.getBreaker("alpha");
        assertSame(b1, b2);
        assertEquals(1, registerCount, "Register should not be called again for same service");

        // Different service should return different instance and trigger another register call
        registerLatch = new java.util.concurrent.CountDownLatch(1);
        var b3 = c.getBreaker("beta");
        assertNotNull(b3);
        assertNotSame(b1, b3);

        assertTrue(registerLatch.await(2, java.util.concurrent.TimeUnit.SECONDS), "Second register request not received");
        assertEquals(2, registerCount, "Expected 2 total register calls after two distinct services");

        // Validate register request payload and method
        assertEquals("POST", lastRegisterMethod);
        assertNotNull(lastRegisterBody);
        assertTrue(lastRegisterBody.contains("\"service\":\"beta\"") || lastRegisterBody.contains("\"service\":\"alpha\""));
        assertTrue(lastRegisterBody.contains("\"failure_threshold\":5"));
        assertTrue(lastRegisterBody.contains("\"success_threshold\":3"));
        assertTrue(lastRegisterBody.contains("\"node_id\":\""));
    }

    @Test
    @DisplayName("reportState should send async POST with correct JSON payload")
    void testReportStateAsyncPost() throws Exception {
        client.reportState("orders", com.polyglot.circuitbreaker.CircuitBreaker.State.OPEN, 7);

        assertTrue(stateLatch.await(2, java.util.concurrent.TimeUnit.SECONDS), "State report was not received");
        assertEquals(1, stateCount);
        assertEquals("POST", lastStateMethod);
        assertNotNull(lastStateBody);
        assertTrue(lastStateBody.contains("\"service\":\"orders\""));
        assertTrue(lastStateBody.contains("\"state\":\"OPEN\""));
        assertTrue(lastStateBody.contains("\"failure_count\":7"));
        assertTrue(lastStateBody.contains("\"timestamp\":"));
    }

    @Test
    @DisplayName("getAggregatedState should parse coordinator JSON response correctly")
    void testGetAggregatedStateSuccessParsing() {
        aggregateResponseJson = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":3,\"health_score\":0.25}";
        DistributedCircuitBreakerClient.AggregatedState ag = client.getAggregatedState("payments");
        assertNotNull(ag);
        assertEquals("payments", ag.service());
        assertEquals("OPEN", ag.consensusState());
        assertEquals(3, ag.totalNodes());
        assertEquals(0.25, ag.healthScore(), 1e-9);
    }

    @Test
    @DisplayName("getAggregatedState should handle missing fields gracefully")
    void testGetAggregatedStateMissingFields() {
        aggregateResponseJson = "{}";
        DistributedCircuitBreakerClient.AggregatedState ag = client.getAggregatedState("any");
        assertNotNull(ag);
        // parseAggregatedState returns empty string for missing string keys and 0/0.0 for numbers
        assertEquals("", ag.service());
        assertEquals("", ag.consensusState());
        assertEquals(0, ag.totalNodes());
        assertEquals(0.0, ag.healthScore(), 1e-9);
    }

    @Test
    @DisplayName("getAggregatedState should return fallback UNKNOWN on network failure")
    void testGetAggregatedStateNetworkFailureFallback() {
        DistributedCircuitBreakerClient badClient = new DistributedCircuitBreakerClient("http://127.0.0.1:0");
        try {
            DistributedCircuitBreakerClient.AggregatedState ag = badClient.getAggregatedState("inventory");
            assertNotNull(ag);
            assertEquals("inventory", ag.service());
            assertEquals("UNKNOWN", ag.consensusState());
            assertEquals(0, ag.totalNodes());
            assertEquals(0.0, ag.healthScore(), 1e-9);
        } finally {
            badClient.shutdown();
        }
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdownIdempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }
}