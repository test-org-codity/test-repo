package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private HttpServer server;
    private String baseUrl;
    private DistributedCircuitBreakerClient client;

    private final AtomicInteger registerCount = new AtomicInteger(0);
    private final AtomicInteger stateCount = new AtomicInteger(0);
    private volatile String lastStateBody = null;
    private final Map<String, String> aggregateResponses = new ConcurrentHashMap<>();

    @BeforeEach
    void setUp() throws Exception {
        startServer();
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
        lastStateBody = null;
        aggregateResponses.clear();
        registerCount.set(0);
        stateCount.set(0);
    }

    private void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);

        server.createContext("/circuit-breakers/register", new HttpHandler() {
            @Override
            public void handle(HttpExchange exchange) throws IOException {
                registerCount.incrementAndGet();
                byte[] resp = "ok".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            }
        });

        server.createContext("/circuit-breakers/state", new HttpHandler() {
            @Override
            public void handle(HttpExchange exchange) throws IOException {
                stateCount.incrementAndGet();
                byte[] bytes = exchange.getRequestBody().readAllBytes();
                lastStateBody = new String(bytes, StandardCharsets.UTF_8);
                byte[] resp = "ok".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, resp.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
            }
        });

        server.createContext("/circuit-breakers/", new HttpHandler() {
            @Override
            public void handle(HttpExchange exchange) throws IOException {
                String path = exchange.getRequestURI().getPath();
                String prefix = "/circuit-breakers/";
                String suffix = "/aggregate";
                if (path.startsWith(prefix) && path.endsWith(suffix)) {
                    int start = prefix.length();
                    int end = path.length() - suffix.length();
                    String service = path.substring(start, end);
                    String body = aggregateResponses.getOrDefault(service, "{\"service\":\"" + service + "\"}");
                    byte[] resp = body.getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, resp.length);
                    try (OutputStream os = exchange.getResponseBody()) {
                        os.write(resp);
                    }
                } else {
                    byte[] resp = "not found".getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(404, resp.length);
                    try (OutputStream os = exchange.getResponseBody()) {
                        os.write(resp);
                    }
                }
            }
        });

        server.start();
        int port = server.getAddress().getPort();
        baseUrl = "http://localhost:" + port;
    }

    @Test
    @DisplayName("Constructor should create instance successfully")
    void testConstructor() {
        assertNotNull(client);
    }

    @Test
    @DisplayName("getBreaker should cache instances per service name")
    void testGetBreaker_CachesInstances() {
        Object b1 = client.getBreaker("svc1");
        Object b2 = client.getBreaker("svc1");
        Object b3 = client.getBreaker("svc2");

        assertNotNull(b1);
        assertSame(b1, b2);
        assertNotSame(b1, b3);
    }

    @Test
    @DisplayName("getBreaker should register with coordinator only for new services")
    void testGetBreaker_RegistersWithCoordinator() {
        assertEquals(0, registerCount.get());

        client.getBreaker("alpha");
        assertEquals(1, registerCount.get(), "First unique service should register once");

        client.getBreaker("alpha");
        assertEquals(1, registerCount.get(), "Fetching same service should not register again");

        client.getBreaker("beta");
        assertEquals(2, registerCount.get(), "Second unique service should register once");
    }

    @Test
    @DisplayName("reportState should POST asynchronously and include required fields")
    void testReportState_PostsAsync() throws Exception {
        String service = "orders";
        int failureCount = 7;
        client.reportState(service, com.polyglot.circuitbreaker.CircuitBreaker.State.OPEN, failureCount);

        long start = System.currentTimeMillis();
        boolean received = false;
        while (System.currentTimeMillis() - start < 2000) {
            if (stateCount.get() > 0 && lastStateBody != null) {
                received = true;
                break;
            }
            Thread.sleep(25);
        }
        assertTrue(received, "Expected state report to be received asynchronously by server");
        assertTrue(lastStateBody.contains("\"service\":\"" + service + "\""), "Body should contain service name");
        assertTrue(lastStateBody.contains("\"state\":\"OPEN\""), "Body should contain state OPEN");
        assertTrue(lastStateBody.contains("\"failure_count\":" + failureCount), "Body should contain failure_count");
        assertTrue(lastStateBody.contains("\"timestamp\":"), "Body should contain timestamp");
    }

    @Test
    @DisplayName("getAggregatedState should parse JSON response correctly")
    void testGetAggregatedState_ParsesResponse() {
        String service = "payments";
        String json = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.75}";
        aggregateResponses.put(service, json);

        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState(service);
        assertNotNull(state);
        assertEquals("payments", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("getAggregatedState should return defaults when JSON lacks fields")
    void testGetAggregatedState_InvalidJsonDefaults() {
        String service = "broken";
        aggregateResponses.put(service, "{}");

        DistributedCircuitBreakerClient.AggregatedState state = client.getAggregatedState(service);
        assertNotNull(state);
        assertEquals("", state.service());
        assertEquals("", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN on network failure")
    void testGetAggregatedState_NetworkFailureReturnsUnknown() throws Exception {
        HttpServer temp = HttpServer.create(new InetSocketAddress(0), 0);
        temp.start();
        int port = temp.getAddress().getPort();
        temp.stop(0); // ensure port is closed/unreachable

        DistributedCircuitBreakerClient failingClient = new DistributedCircuitBreakerClient("http://127.0.0.1:" + port);
        try {
            DistributedCircuitBreakerClient.AggregatedState state = failingClient.getAggregatedState("any");
            assertNotNull(state);
            assertEquals("UNKNOWN", state.consensusState());
            assertEquals(0, state.totalNodes());
            assertEquals(0.0, state.healthScore(), 0.000001);
            assertEquals("any", state.service());
        } finally {
            failingClient.shutdown();
        }
    }

    @Test
    @DisplayName("shutdown should be idempotent and not throw")
    void testShutdown_Idempotent() {
        client.shutdown();
        client.shutdown();
        // No exception expected
        assertTrue(true);
    }

    @Test
    @DisplayName("getBreaker should throw NullPointerException for null service name")
    void testGetBreaker_NullService_ThrowsNPE() {
        assertThrows(NullPointerException.class, () -> client.getBreaker(null));
    }

    @Test
    @DisplayName("reportState should throw NullPointerException when state is null")
    void testReportState_NullState_ThrowsNPE() {
        assertThrows(NullPointerException.class, () ->
            client.reportState("svc", null, 1)
        );
    }

    @Test
    @DisplayName("AggregatedState record accessors should return provided values")
    void testAggregatedStateRecord() {
        DistributedCircuitBreakerClient.AggregatedState s =
            new DistributedCircuitBreakerClient.AggregatedState("svc", "CLOSED", 3, 0.9);
        assertEquals("svc", s.service());
        assertEquals("CLOSED", s.consensusState());
        assertEquals(3, s.totalNodes());
        assertEquals(0.9, s.healthScore(), 0.000001);
    }

    @Test
    @DisplayName("reportState should not throw on unreachable coordinator")
    void testReportState_DoesNotThrowOnUnreachableCoordinator() {
        DistributedCircuitBreakerClient failingClient = new DistributedCircuitBreakerClient("http://127.0.0.1:1");
        try {
            assertDoesNotThrow(() ->
                failingClient.reportState("svcX", com.polyglot.circuitbreaker.CircuitBreaker.State.CLOSED, 0)
            );
        } finally {
            failingClient.shutdown();
        }
    }
}