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
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private HttpServer server;
    private String baseUrl;
    private DistributedCircuitBreakerClient client;

    // Test server state
    private final AtomicInteger registerCount = new AtomicInteger(0);
    private final AtomicInteger stateCount = new AtomicInteger(0);
    private volatile String lastRegisterBody;
    private volatile String lastStateBody;
    private volatile String lastAggregatePath;
    private volatile String aggregatedResponseBody;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/circuit-breakers", this::handleCircuitBreakers);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        client = new DistributedCircuitBreakerClient(baseUrl);
        // Reset captured data
        registerCount.set(0);
        stateCount.set(0);
        lastRegisterBody = null;
        lastStateBody = null;
        lastAggregatePath = null;
        aggregatedResponseBody = null;
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

    private void handleCircuitBreakers(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();

        if (path.endsWith("/register") && "POST".equalsIgnoreCase(method)) {
            registerCount.incrementAndGet();
            byte[] body = exchange.getRequestBody().readAllBytes();
            lastRegisterBody = new String(body, StandardCharsets.UTF_8);
            respond(exchange, 200, "OK");
            return;
        }

        if (path.endsWith("/state") && "POST".equalsIgnoreCase(method)) {
            stateCount.incrementAndGet();
            byte[] body = exchange.getRequestBody().readAllBytes();
            lastStateBody = new String(body, StandardCharsets.UTF_8);
            respond(exchange, 200, "OK");
            return;
        }

        if (path.endsWith("/aggregate") && "GET".equalsIgnoreCase(method)) {
            lastAggregatePath = path;
            String body = aggregatedResponseBody != null
                ? aggregatedResponseBody
                : "{\"service\":\"unknown\",\"consensus_state\":\"UNKNOWN\",\"total_nodes\":0,\"health_score\":0.0}";
            respond(exchange, 200, body);
            return;
        }

        respond(exchange, 404, "Not Found");
    }

    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    @Test
    @DisplayName("Constructor creates instance and shutdown completes without error")
    void testConstructorAndShutdown() {
        assertNotNull(client);
        // Call shutdown twice to ensure idempotency
        client.shutdown();
        client.shutdown();
    }

    @Test
    @DisplayName("getBreaker returns cached instance per service and registers once")
    void testGetBreaker_CachingAndRegistration() {
        String service1 = "payments";
        String service2 = "orders";

        CircuitBreaker<Object> b1 = client.getBreaker(service1);
        assertNotNull(b1);
        assertEquals(1, registerCount.get(), "First getBreaker should register once");

        CircuitBreaker<Object> b1_again = client.getBreaker(service1);
        assertSame(b1, b1_again, "getBreaker should cache instance per service");
        assertEquals(1, registerCount.get(), "Second getBreaker for same service should not re-register");

        CircuitBreaker<Object> b2 = client.getBreaker(service2);
        assertNotNull(b2);
        assertEquals(2, registerCount.get(), "New service should trigger a new registration");

        // Inspect register body contains node_id and service name
        assertNotNull(lastRegisterBody);
        String expectedNodeIdPrefix = "\"node_id\":\"java-" + ProcessHandle.current().pid();
        assertTrue(lastRegisterBody.contains("\"service\":\"" + service2 + "\""));
        assertTrue(lastRegisterBody.contains(expectedNodeIdPrefix));
    }

    @Test
    @DisplayName("getBreaker with null service name throws NullPointerException")
    void testGetBreaker_NullServiceName_Throws() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState sends asynchronous POST with correct payload")
    void testReportState_Posts() throws Exception {
        String service = "inventory";
        client.reportState(service, CircuitBreaker.State.OPEN, 7);

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline && stateCount.get() < 1) {
            Thread.sleep(10);
        }
        assertEquals(1, stateCount.get(), "Expected one state report POST");

        assertNotNull(lastStateBody);
        assertTrue(lastStateBody.contains("\"service\":\"" + service + "\""));
        assertTrue(lastStateBody.contains("\"state\":\"OPEN\""));
        assertTrue(lastStateBody.contains("\"failure_count\":7"));
    }

    @Test
    @DisplayName("reportState with null state does not throw and does not send payload")
    void testReportState_NullState_NoThrow() throws Exception {
        String service = "billing";
        // Should not throw, internal try/catch swallows exceptions
        client.reportState(service, null, 1);

        // Give some time to see if any async call was attempted
        Thread.sleep(100);
        assertEquals(0, stateCount.get(), "Null state should not send a valid report");
    }

    @Test
    @DisplayName("getAggregatedState parses valid response JSON")
    void testGetAggregatedState_ParsesResponse() {
        String service = "payments";
        aggregatedResponseBody = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":3,\"health_score\":0.42}";

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState(service);
        assertNotNull(agg);
        assertEquals("payments", agg.service());
        assertEquals("OPEN", agg.consensusState());
        assertEquals(3, agg.totalNodes());
        assertEquals(0.42, agg.healthScore(), 0.0001);
        assertNotNull(lastAggregatePath);
        assertTrue(lastAggregatePath.endsWith("/circuit-breakers/" + service + "/aggregate"));
    }

    @Test
    @DisplayName("getAggregatedState returns fallback UNKNOWN on HTTP exception")
    void testGetAggregatedState_ExceptionFallback() {
        server.stop(0); // Force connection failure

        String service = "shipping";
        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState(service);
        assertNotNull(agg);
        assertEquals(service, agg.service());
        assertEquals("UNKNOWN", agg.consensusState());
        assertEquals(0, agg.totalNodes());
        assertEquals(0.0, agg.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState with malformed JSON yields default-extracted values")
    void testGetAggregatedState_MalformedJson() {
        aggregatedResponseBody = "{}"; // Missing all fields

        DistributedCircuitBreakerClient.AggregatedState agg = client.getAggregatedState("any");
        assertNotNull(agg);
        assertEquals("", agg.service(), "Missing 'service' should parse as empty string");
        assertEquals("", agg.consensusState(), "Missing 'consensus_state' should parse as empty string");
        assertEquals(0, agg.totalNodes(), "Missing 'total_nodes' should parse as 0");
        assertEquals(0.0, agg.healthScore(), 0.0001, "Missing 'health_score' should parse as 0.0");
    }
}