package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    @Test
    @DisplayName("Constructor should create instance and shutdown is idempotent")
    void testConstructorAndShutdown() {
        DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        assertNotNull(client);
        assertDoesNotThrow(client::shutdown);
        assertDoesNotThrow(client::shutdown);
    }

    @Test
    @DisplayName("getBreaker returns same instance for same service and registers once")
    void testGetBreakerCachingAndSingleRegister() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());
            CircuitBreaker<Object> b1 = client.getBreaker("serviceA");
            CircuitBreaker<Object> b2 = client.getBreaker("serviceA");
            assertNotNull(b1);
            assertSame(b1, b2, "Breaker should be cached per service");
            assertEquals(1, server.getRegisterCount(), "Register should be called once for a new service");
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    @Test
    @DisplayName("getBreaker returns different instances for different services and registers each")
    void testGetBreakerDifferentServices() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());
            CircuitBreaker<Object> b1 = client.getBreaker("svc1");
            CircuitBreaker<Object> b2 = client.getBreaker("svc2");
            assertNotNull(b1);
            assertNotNull(b2);
            assertNotSame(b1, b2, "Different services should have different breakers");
            assertEquals(2, server.getRegisterCount(), "Each distinct service should be registered once");
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    @Test
    @DisplayName("getBreaker does not throw when coordinator is unavailable")
    void testGetBreakerCoordinatorUnavailable() {
        DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        assertDoesNotThrow(() -> {
            CircuitBreaker<Object> breaker = client.getBreaker("unreachable");
            assertNotNull(breaker);
        });
        client.shutdown();
    }

    @Test
    @DisplayName("reportState sends asynchronously and does not throw on success")
    void testReportStateAsync() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());
            client.reportState("svc", CircuitBreaker.State.CLOSED, 0);

            // Wait up to 2 seconds for async request to arrive
            boolean reached = server.awaitStateCountAtLeast(1, 2000);
            assertTrue(reached, "Expected at least one state report to be received");
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    @Test
    @DisplayName("reportState does not throw when coordinator is unavailable")
    void testReportStateCoordinatorUnavailable() {
        DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        assertDoesNotThrow(() -> client.reportState("svc", CircuitBreaker.State.OPEN, 2));
        client.shutdown();
    }

    @Test
    @DisplayName("getAggregatedState parses valid JSON response")
    void testGetAggregatedStateParsesJson() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            String json = "{\"service\":\"orders\",\"consensus_state\":\"OPEN\",\"total_nodes\":3,\"health_score\":0.42}";
            server.setAggregatedResponse("orders", json);

            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());
            DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("orders");

            assertNotNull(agg);
            assertEquals("orders", agg.service());
            assertEquals("OPEN", agg.consensusState());
            assertEquals(3, agg.totalNodes());
            assertEquals(0.42, agg.healthScore(), 0.0001);
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    @Test
    @DisplayName("getAggregatedState returns UNKNOWN fallback on error")
    void testGetAggregatedStateFallbackOnError() {
        DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("payments");
        assertNotNull(agg);
        assertEquals("payments", agg.service());
        assertEquals("UNKNOWN", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0001);
        client.shutdown();
    }

    @Test
    @DisplayName("getAggregatedState handles missing fields gracefully")
    void testGetAggregatedStateMissingFields() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            String json = "{\"service\":\"catalog\"}";
            server.setAggregatedResponse("catalog", json);

            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());
            DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("catalog");

            assertNotNull(agg);
            assertEquals("catalog", agg.service());
            assertEquals("", agg.consensusState(), "Missing consensus_state should default to empty string");
            assertEquals(0, agg.totalNodes(), "Missing total_nodes should default to 0");
            assertEquals(0.0, agg.healthScore(), 0.0001, "Missing health_score should default to 0.0");
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    @Test
    @DisplayName("Concurrent getBreaker calls result in a single registration and same instance")
    void testConcurrentGetBreakerSingleRegistration() throws Exception {
        TestHttpServer server = TestHttpServer.start();
        try {
            DistributedCircuitBreakerClient client = new DistributedCircuitBreakerClient(server.baseUrl());

            int threads = 10;
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            CountDownLatch start = new CountDownLatch(1);
            CountDownLatch done = new CountDownLatch(threads);
            CopyOnWriteArrayList<CircuitBreaker<Object>> breakers = new CopyOnWriteArrayList<>();

            for (int i = 0; i < threads; i++) {
                pool.execute(() -> {
                    try {
                        start.await();
                        breakers.add(client.getBreaker("concurrentService"));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        done.countDown();
                    }
                });
            }

            start.countDown();
            assertTrue(done.await(3, TimeUnit.SECONDS), "All tasks should complete");

            assertFalse(breakers.isEmpty());
            CircuitBreaker<Object> first = breakers.get(0);
            for (CircuitBreaker<Object> b : breakers) {
                assertSame(first, b, "All threads should receive the same breaker instance");
            }

            assertEquals(1, server.getRegisterCount(), "Registration should happen only once");
            pool.shutdownNow();
            client.shutdown();
        } finally {
            server.stop();
        }
    }

    // Helper HTTP server for tests
    static class TestHttpServer {
        private final HttpServer server;
        private final AtomicInteger registerCount = new AtomicInteger();
        private final AtomicInteger stateCount = new AtomicInteger();
        private final Map<String, String> aggregateResponses = new ConcurrentHashMap<>();

        private TestHttpServer(HttpServer server) {
            this.server = server;
        }

        static TestHttpServer start() throws IOException {
            HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
            TestHttpServer wrapper = new TestHttpServer(server);
            server.createContext("/", wrapper::handle);
            server.setExecutor(Executors.newCachedThreadPool());
            server.start();
            return wrapper;
        }

        void stop() {
            try {
                server.stop(0);
            } catch (Exception ignored) {
            }
        }

        String baseUrl() {
            return "http://localhost:" + server.getAddress().getPort();
        }

        int getRegisterCount() {
            return registerCount.get();
        }

        int getStateCount() {
            return stateCount.get();
        }

        boolean awaitStateCountAtLeast(int expected, long timeoutMs) throws InterruptedException {
            long start = System.currentTimeMillis();
            while (System.currentTimeMillis() - start < timeoutMs) {
                if (stateCount.get() >= expected) return true;
                Thread.sleep(10);
            }
            return stateCount.get() >= expected;
        }

        void setAggregatedResponse(String service, String json) {
            aggregateResponses.put(service, json);
        }

        private void handle(HttpExchange exchange) throws IOException {
            try {
                String method = exchange.getRequestMethod();
                String path = exchange.getRequestURI().getPath();

                // Drain request body if present
                try (InputStream is = exchange.getRequestBody()) {
                    if (is != null) {
                        byte[] buf = new byte[1024];
                        while (is.read(buf) != -1) {
                            // discard
                        }
                    }
                }

                String response = "{}";
                int status = 200;

                if ("POST".equalsIgnoreCase(method) && "/circuit-breakers/register".equals(path)) {
                    registerCount.incrementAndGet();
                    response = "{\"status\":\"ok\"}";
                } else if ("POST".equalsIgnoreCase(method) && "/circuit-breakers/state".equals(path)) {
                    stateCount.incrementAndGet();
                    response = "{\"status\":\"ok\"}";
                } else if ("GET".equalsIgnoreCase(method) && path.startsWith("/circuit-breakers/") && path.endsWith("/aggregate")) {
                    String service = extractServiceFromPath(path);
                    String json = aggregateResponses.get(service);
                    if (json == null) {
                        json = "{\"service\":\"" + service + "\",\"consensus_state\":\"UNKNOWN\",\"total_nodes\":0,\"health_score\":0.0}";
                    }
                    response = json;
                } else {
                    status = 404;
                    response = "{\"error\":\"not_found\"}";
                }

                Headers headers = exchange.getResponseHeaders();
                headers.add("Content-Type", "application/json");
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            } catch (Exception e) {
                byte[] bytes = ("{\"error\":\"" + e.getMessage() + "\"}").getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            } finally {
                exchange.close();
            }
        }

        private String extractServiceFromPath(String path) {
            // Expected: /circuit-breakers/{service}/aggregate
            String[] parts = path.split("/");
            if (parts.length >= 4) {
                return parts[2]; // parts[0] = "", [1] = "circuit-breakers", [2] = service, [3] = "aggregate"
            }
            return "";
        }
    }
}