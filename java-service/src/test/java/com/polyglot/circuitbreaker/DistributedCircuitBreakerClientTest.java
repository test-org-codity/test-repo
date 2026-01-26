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
    private int port;
    private DistributedCircuitBreakerClient client;

    private final java.util.concurrent.atomic.AtomicInteger registerCount = new java.util.concurrent.atomic.AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicInteger stateCount = new java.util.concurrent.atomic.AtomicInteger(0);
    private volatile String lastStateBody;
    private volatile String aggregateResponseJson;
    private volatile java.util.concurrent.CountDownLatch statePostLatch;

    @BeforeEach
    void setUp() throws Exception {
        server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);

        // Register endpoint
        server.createContext("/circuit-breakers/register", exchange -> {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                registerCount.incrementAndGet();
                try (java.io.InputStream is = exchange.getRequestBody()) {
                    if (is != null) {
                        is.readAllBytes(); // consume body
                    }
                }
                byte[] resp = "OK".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
            }
            exchange.close();
        });

        // State report endpoint
        server.createContext("/circuit-breakers/state", exchange -> {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                stateCount.incrementAndGet();
                try (java.io.InputStream is = exchange.getRequestBody()) {
                    lastStateBody = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                }
                if (statePostLatch != null) {
                    statePostLatch.countDown();
                }
                byte[] resp = "OK".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(405, -1);
            }
            exchange.close();
        });

        // Aggregate endpoint (prefix match)
        server.createContext("/circuit-breakers/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod()) && path != null && path.endsWith("/aggregate")) {
                String body = aggregateResponseJson != null ? aggregateResponseJson : "{\"service\":\"default\",\"consensus_state\":\"CLOSED\",\"total_nodes\":1,\"health_score\":1.0}";
                byte[] resp = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (java.io.OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            } else {
                exchange.sendResponseHeaders(404, -1);
            }
            exchange.close();
        });

        server.start();
        port = server.getAddress().getPort();

        client = new DistributedCircuitBreakerClient("http://127.0.0.1:" + port);
    }

    @AfterEach
    void tearDown() {
        try {
            if (client != null) {
                client.shutdown();
            }
        } catch (Throwable ignore) { }
        try {
            if (server != null) {
                server.stop(0);
            }
        } catch (Throwable ignore) { }
        statePostLatch = null;
        aggregateResponseJson = null;
        lastStateBody = null;
        registerCount.set(0);
        stateCount.set(0);
    }

    @Test
    @DisplayName("Constructor should create instance and start without exceptions")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache instances per service and register once")
    void testGetBreaker_CachesAndRegistersOnce() {
        CircuitBreaker<Object> a1 = client.getBreaker("svcA");
        CircuitBreaker<Object> a2 = client.getBreaker("svcA");
        assertNotNull(a1);
        assertSame(a1, a2, "Breaker for same service should be cached and identical");
        assertEquals(1, registerCount.get(), "Register should be called once for svcA");

        CircuitBreaker<Object> b = client.getBreaker("svcB");
        assertNotNull(b);
        assertNotSame(a1, b, "Different services should yield different breaker instances");
        assertEquals(2, registerCount.get(), "Register should be called once per distinct service");
    }

    @Test
    @DisplayName("getBreaker should be thread-safe and register only once under concurrent access")
    void testGetBreaker_ConcurrentAccess() throws Exception {
        final String service = "concurrent";
        final Object[] holders = new Object[2];
        java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        Thread t1 = new Thread(() -> {
            try {
                start.await();
                holders[0] = client.getBreaker(service);
            } catch (InterruptedException ignored) { }
        });
        Thread t2 = new Thread(() -> {
            try {
                start.await();
                holders[1] = client.getBreaker(service);
            } catch (InterruptedException ignored) { }
        });
        t1.start();
        t2.start();
        start.countDown();
        t1.join(2000);
        t2.join(2000);

        assertNotNull(holders[0]);
        assertNotNull(holders[1]);
        assertSame(holders[0], holders[1], "Both threads should receive the same cached instance");
        assertEquals(1, registerCount.get(), "Coordinator registration should occur only once");
    }

    @Test
    @DisplayName("reportState should POST asynchronously with expected payload")
    void testReportState_SendsAsyncPost() throws Exception {
        statePostLatch = new java.util.concurrent.CountDownLatch(1);
        client.reportState("payments", CircuitBreaker.State.OPEN, 7);

        boolean received = statePostLatch.await(3, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(received, "State report should be received by server");
        assertTrue(stateCount.get() >= 1, "At least one state POST should be recorded");
        assertNotNull(lastStateBody, "State POST body should be captured");

        assertTrue(lastStateBody.contains("\"service\":\"payments\""), "Body should include service name");
        assertTrue(lastStateBody.contains("\"state\":\"OPEN\""), "Body should include OPEN state");
        assertTrue(lastStateBody.contains("\"failure_count\":7"), "Body should include failure_count");
        assertTrue(lastStateBody.contains("\"node_id\":\""), "Body should include node_id");
        assertTrue(lastStateBody.contains("\"timestamp\":"), "Body should include timestamp");
    }

    @Test
    @DisplayName("getAggregatedState should parse successful JSON response")
    void testGetAggregatedState_ParsesJson() {
        aggregateResponseJson = "{\"service\":\"catalog\",\"consensus_state\":\"HALF_OPEN\",\"total_nodes\":5,\"health_score\":0.66}";
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("catalog");
        assertNotNull(state);
        assertEquals("catalog", state.service());
        assertEquals("HALF_OPEN", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.66, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should handle malformed/partial JSON gracefully")
    void testGetAggregatedState_MalformedJson() {
        aggregateResponseJson = "{}";
        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState("ignored");
        assertNotNull(state);
        assertEquals("", state.service(), "Missing service should parse as empty string");
        assertEquals("", state.consensusState(), "Missing consensus_state should parse as empty string");
        assertEquals(0, state.totalNodes(), "Missing total_nodes should parse as 0");
        assertEquals(0.0, state.healthScore(), 0.000001, "Missing health_score should parse as 0.0");
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on unreachable coordinator")
    void testGetAggregatedState_UnreachableCoordinator() {
        DistributedCircuitBreakerClient unreachable = new DistributedCircuitBreakerClient("http://127.0.0.1:0");
        try {
            DistributedCircuitBreakerClient.AggregatedState state = unreachable.getAggregatedState("svc");
            assertNotNull(state);
            assertEquals("svc", state.service());
            assertEquals("UNKNOWN", state.consensusState());
            assertEquals(0, state.totalNodes());
            assertEquals(0.0, state.healthScore(), 0.000001);
        } finally {
            unreachable.shutdown();
        }
    }

    @Test
    @DisplayName("synchronizeStates should report current breaker states (invoked via reflection)")
    void testSynchronizeStates_ReportsStates() throws Exception {
        client.getBreaker("orders");
        int before = stateCount.get();
        statePostLatch = new java.util.concurrent.CountDownLatch(1);

        java.lang.reflect.Method m = DistributedCircuitBreakerClient.class.getDeclaredMethod("synchronizeStates");
        m.setAccessible(true);
        m.invoke(client);

        boolean received = statePostLatch.await(3, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(received, "State report should be sent during synchronization");
        assertTrue(stateCount.get() > before, "State count should increase after synchronizeStates");
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        assertDoesNotThrow(() -> client.shutdown());
        assertDoesNotThrow(() -> client.shutdown());
    }
}