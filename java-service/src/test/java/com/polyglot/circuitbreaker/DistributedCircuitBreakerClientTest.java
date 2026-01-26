package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient client;
    private HttpServer server;
    private int port;

    private AtomicInteger registerCount;
    private AtomicInteger stateCount;

    private volatile String lastRegisterBody;
    private volatile String lastStateBody;
    private volatile String aggregateResponse;

    @BeforeEach
    void setUp() throws Exception {
        registerCount = new AtomicInteger(0);
        stateCount = new AtomicInteger(0);
        aggregateResponse = "{\"service\":\"default\",\"consensus_state\":\"CLOSED\",\"total_nodes\":1,\"health_score\":1.0}";

        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();

        server.createContext("/circuit-breakers", this::handleCircuitBreakerRequests);
        server.start();

        client = new DistributedCircuitBreakerClient("http://localhost:" + port);
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

    private void handleCircuitBreakerRequests(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();

        if (path.endsWith("/register") && "POST".equalsIgnoreCase(method)) {
            lastRegisterBody = readBody(exchange);
            registerCount.incrementAndGet();
            respond(exchange, 200, "registered");
            return;
        }

        if (path.endsWith("/state") && "POST".equalsIgnoreCase(method)) {
            lastStateBody = readBody(exchange);
            stateCount.incrementAndGet();
            respond(exchange, 200, "ok");
            return;
        }

        if (path.contains("/aggregate") && "GET".equalsIgnoreCase(method)) {
            respond(exchange, 200, aggregateResponse);
            return;
        }

        respond(exchange, 404, "not-found");
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream is = exchange.getRequestBody()) {
            byte[] bytes = is.readAllBytes();
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void sleepSilently(long millis) {
        try {
            TimeUnit.MILLISECONDS.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    @DisplayName("Should construct client with coordinator URL")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache and return same instance per service and register once")
    void testGetBreaker_CachingAndRegistration() {
        com.polyglot.circuitbreaker.CircuitBreaker<Object> b1 = client.getBreaker("service-A");
        com.polyglot.circuitbreaker.CircuitBreaker<Object> b2 = client.getBreaker("service-A");
        com.polyglot.circuitbreaker.CircuitBreaker<Object> b3 = client.getBreaker("service-B");

        assertNotNull(b1);
        assertSame(b1, b2);
        assertNotSame(b1, b3);

        // Registration should occur once per unique service
        assertEquals(2, registerCount.get(), "Expected two registration calls (service-A and service-B)");
        assertNotNull(lastRegisterBody);
        assertTrue(lastRegisterBody.contains("\"service\":\"service-B\""), "Register body should contain the last service name");
    }

    @Test
    @DisplayName("reportState should send state asynchronously without throwing")
    void testReportState_SendsAsync() {
        int before = stateCount.get();
        client.reportState("state-service", com.polyglot.circuitbreaker.CircuitBreaker.State.OPEN, 2);

        // Wait a bit for async send to reach the server
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < 1500 && stateCount.get() == before) {
            sleepSilently(50);
        }
        assertTrue(stateCount.get() > before, "Expected state endpoint to be hit at least once");
        assertNotNull(lastStateBody);
        assertTrue(lastStateBody.contains("\"service\":\"state-service\""), "State body should include service");
        assertTrue(lastStateBody.contains("\"state\":\"OPEN\""), "State body should include state");
        assertTrue(lastStateBody.contains("\"failure_count\":2"), "State body should include failure_count");
    }

    @Test
    @DisplayName("getAggregatedState should parse valid JSON response")
    void testGetAggregatedState_ParsesValidJson() {
        aggregateResponse = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.62}";

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("payments");

        assertNotNull(agg);
        assertEquals("payments", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(5, agg.totalNodes());
        assertEquals(0.62, agg.healthScore(), 1e-9);
    }

    @Test
    @DisplayName("getAggregatedState with malformed JSON falls back to parser defaults")
    void testGetAggregatedState_MalformedJson() {
        aggregateResponse = "not a json at all";

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("whatever");

        // Parser extracts empty strings and zeros when keys are missing or malformed
        assertNotNull(agg);
        assertEquals("", agg.service());
        assertEquals("", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on request failure")
    void testGetAggregatedState_OnFailureReturnsUnknown() {
        DistributedCircuitBreakerClient failingClient = new DistributedCircuitBreakerClient("http://127.0.0.1:0");
        try {
            DistributedCircuitBreakerClient.AggregatedState agg = failingClient.getAggregatedState("downstream");
            assertNotNull(agg);
            assertEquals("downstream", agg.service());
            assertEquals("UNKNOWN", agg.consensusState());
            assertEquals(0, agg.totalNodes());
            assertEquals(0.0, agg.healthScore(), 0.0);
        } finally {
            failingClient.shutdown();
        }
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