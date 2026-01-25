package com.polyglot.circuitbreaker;

import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient;
import com.polyglot.circuitbreaker.DistributedCircuitBreakerClient.AggregatedState;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.http.HttpClient;
import java.net.http.HttpResponse;
import java.net.http.HttpRequest;
import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient distributedCircuitBreakerClient;
    private String coordinatorUrl;

    @BeforeEach
    void setUp() {
        // Use a dummy URL; we will replace the HttpClient via reflection to avoid real network calls
        coordinatorUrl = "http://localhost:9999";
        distributedCircuitBreakerClient = new DistributedCircuitBreakerClient(coordinatorUrl);
        replaceHttpClientWithDummy(distributedCircuitBreakerClient);
    }

    @AfterEach
    void tearDown() {
        if (distributedCircuitBreakerClient != null) {
            distributedCircuitBreakerClient.shutdown();
        }
        distributedCircuitBreakerClient = null;
    }

    /**
     * Replace the internal HttpClient with a dummy implementation that never performs real network I/O.
     */
    private void replaceHttpClientWithDummy(DistributedCircuitBreakerClient client) {
        try {
            Field httpClientField = DistributedCircuitBreakerClient.class.getDeclaredField("httpClient");
            httpClientField.setAccessible(true);

            HttpClient dummyClient = new HttpClient() {
                @Override
                public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler) {
                    // Return a simple dummy response with an empty body
                    return new HttpResponse<T>() {
                        @Override
                        public int statusCode() {
                            return 200;
                        }

                        @Override
                        public HttpRequest request() {
                            return request;
                        }

                        @Override
                        public Optional<HttpResponse<T>> previousResponse() {
                            return Optional.empty();
                        }

                        @Override
                        public HttpHeaders headers() {
                            return HttpHeaders.of(Map.of(), (k, v) -> true);
                        }

                        @Override
                        public T body() {
                            return responseBodyHandler.apply(this).apply(java.nio.ByteBuffer.allocate(0));
                        }

                        @Override
                        public Optional<SSLSession> sslSession() {
                            return Optional.empty();
                        }

                        @Override
                        public URI uri() {
                            return request.uri();
                        }

                        @Override
                        public Version version() {
                            return Version.HTTP_1_1;
                        }
                    };
                }

                @Override
                public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler) {
                    return CompletableFuture.completedFuture(send(request, responseBodyHandler));
                }

                @Override
                public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler, HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
                    return CompletableFuture.completedFuture(send(request, responseBodyHandler));
                }

                @Override
                public Optional<CookieHandler> cookieHandler() {
                    return Optional.empty();
                }

                @Override
                public Optional<Duration> connectTimeout() {
                    return Optional.of(Duration.ofSeconds(5));
                }

                @Override
                public Redirect followRedirects() {
                    return Redirect.NEVER;
                }

                @Override
                public Optional<ProxySelector> proxy() {
                    return Optional.empty();
                }

                @Override
                public SSLContext sslContext() {
                    return null;
                }

                @Override
                public SSLParameters sslParameters() {
                    return null;
                }

                @Override
                public Optional<Authenticator> authenticator() {
                    return Optional.empty();
                }

                @Override
                public Version version() {
                    return Version.HTTP_1_1;
                }

                @Override
                public Executor executor() {
                    return null;
                }
            };

            httpClientField.set(client, dummyClient);
        } catch (Exception e) {
            fail("Failed to replace HttpClient via reflection: " + e.getMessage());
        }
    }

    @Test
    @DisplayName("Constructor should create instance and start with running=true")
    void testConstructor() throws Exception {
        assertNotNull(distributedCircuitBreakerClient);

        Field runningField = DistributedCircuitBreakerClient.class.getDeclaredField("running");
        runningField.setAccessible(true);
        boolean running = (boolean) runningField.get(distributedCircuitBreakerClient);
        assertTrue(running, "Client should be running after construction");
    }

    @Test
    @DisplayName("getBreaker should create and cache CircuitBreaker per service name")
    void testGetBreaker_CachesPerService() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceA");
        CircuitBreaker<Object> breaker3 = distributedCircuitBreakerClient.getBreaker("serviceB");

        assertNotNull(breaker1);
        assertNotNull(breaker2);
        assertNotNull(breaker3);

        assertSame(breaker1, breaker2, "Same service name should return same CircuitBreaker instance");
        assertNotSame(breaker1, breaker3, "Different service names should return different CircuitBreaker instances");
    }

    @Test
    @DisplayName("getBreaker should register breaker in localBreakers map")
    void testGetBreaker_RegistersInLocalMap() throws Exception {
        String serviceName = "serviceMapTest";
        distributedCircuitBreakerClient.getBreaker(serviceName);

        Field localBreakersField = DistributedCircuitBreakerClient.class.getDeclaredField("localBreakers");
        localBreakersField.setAccessible(true);
        Map<?, ?> localBreakers = (Map<?, ?>) localBreakersField.get(distributedCircuitBreakerClient);

        assertTrue(localBreakers.containsKey(serviceName), "localBreakers should contain the created service name");
        assertNotNull(localBreakers.get(serviceName));
    }

    @Test
    @DisplayName("reportState should not throw exceptions for normal input")
    void testReportState_NoException() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("reportService");
        breaker.recordFailure(new RuntimeException("test failure"));

        assertDoesNotThrow(() ->
                distributedCircuitBreakerClient.reportState("reportService", breaker.getState(), breaker.getFailureCount())
        );
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN state on failure to contact coordinator")
    void testGetAggregatedState_FailureReturnsUnknown() throws Exception {
        // Replace HttpClient with one that always throws to simulate failure
        Field httpClientField = DistributedCircuitBreakerClient.class.getDeclaredField("httpClient");
        httpClientField.setAccessible(true);

        HttpClient throwingClient = new HttpClient() {
            @Override
            public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler) throws java.io.IOException, InterruptedException {
                throw new java.io.IOException("Simulated failure");
            }

            @Override
            public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler) {
                CompletableFuture<HttpResponse<T>> future = new CompletableFuture<>();
                future.completeExceptionally(new java.io.IOException("Simulated failure"));
                return future;
            }

            @Override
            public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler, HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
                return sendAsync(request, responseBodyHandler);
            }

            @Override
            public Optional<CookieHandler> cookieHandler() {
                return Optional.empty();
            }

            @Override
            public Optional<Duration> connectTimeout() {
                return Optional.of(Duration.ofSeconds(5));
            }

            @Override
            public Redirect followRedirects() {
                return Redirect.NEVER;
            }

            @Override
            public Optional<ProxySelector> proxy() {
                return Optional.empty();
            }

            @Override
            public SSLContext sslContext() {
                return null;
            }

            @Override
            public SSLParameters sslParameters() {
                return null;
            }

            @Override
            public Optional<Authenticator> authenticator() {
                return Optional.empty();
            }

            @Override
            public Version version() {
                return Version.HTTP_1_1;
            }

            @Override
            public Executor executor() {
                return null;
            }
        };

        httpClientField.set(distributedCircuitBreakerClient, throwingClient);

        AggregatedState state = distributedCircuitBreakerClient.getAggregatedState("anyService");
        assertNotNull(state);
        assertEquals("anyService", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("AggregatedState record should expose values correctly")
    void testAggregatedStateRecord() {
        AggregatedState state = new AggregatedState("svc", "OPEN", 3, 0.75);

        assertEquals("svc", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("shutdown should stop sync thread by setting running=false")
    void testShutdownStopsRunningFlag() throws Exception {
        Field runningField = DistributedCircuitBreakerClient.class.getDeclaredField("running");
        runningField.setAccessible(true);

        boolean before = (boolean) runningField.get(distributedCircuitBreakerClient);
        assertTrue(before, "running should be true before shutdown");

        distributedCircuitBreakerClient.shutdown();

        boolean after = (boolean) runningField.get(distributedCircuitBreakerClient);
        assertFalse(after, "running should be false after shutdown");
    }

    @Test
    @DisplayName("JSON parsing helpers should correctly parse valid JSON")
    void testParseAggregatedState_ValidJson() throws Exception {
        String json = "{\"service\":\"payments\",\"consensus_state\":\"CLOSED\",\"total_nodes\":5,\"health_score\":0.92}";

        Method parseMethod = DistributedCircuitBreakerClient.class.getDeclaredMethod("parseAggregatedState", String.class);
        parseMethod.setAccessible(true);

        AggregatedState state = (AggregatedState) parseMethod.invoke(distributedCircuitBreakerClient, json);

        assertEquals("payments", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.92, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("JSON parsing helpers should handle missing or malformed fields gracefully")
    void testParseAggregatedState_MalformedJson() throws Exception {
        String json = "{\"servicex\":\"wrong\",\"consensus_statex\":\"OPEN\",\"total_nodesx\":\"NaN\",\"health_scorex\":\"bad\"}";

        Method parseMethod = DistributedCircuitBreakerClient.class.getDeclaredMethod("parseAggregatedState", String.class);
        parseMethod.setAccessible(true);

        AggregatedState state = (AggregatedState) parseMethod.invoke(distributedCircuitBreakerClient, json);

        assertEquals("", state.service());
        assertEquals("", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("extractJsonString should return empty string when key not found")
    void testExtractJsonString_KeyNotFound() throws Exception {
        String json = "{\"a\":\"b\"}";
        Method method = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonString", String.class, String.class);
        method.setAccessible(true);

        String result = (String) method.invoke(distributedCircuitBreakerClient, json, "missing");
        assertEquals("", result);
    }

    @Test
    @DisplayName("extractJsonInt should return 0 when value is not a valid integer")
    void testExtractJsonInt_Invalid() throws Exception {
        String json = "{\"value\":\"notAnInt\"}";
        Method method = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonInt", String.class, String.class);
        method.setAccessible(true);

        int result = (int) method.invoke(distributedCircuitBreakerClient, json, "value");
        assertEquals(0, result);
    }

    @Test
    @DisplayName("extractJsonDouble should return 0.0 when value is not a valid double")
    void testExtractJsonDouble_Invalid() throws Exception {
        String json = "{\"value\":\"notADouble\"}";
        Method method = DistributedCircuitBreakerClient.class.getDeclaredMethod("extractJsonDouble", String.class, String.class);
        method.setAccessible(true);

        double result = (double) method.invoke(distributedCircuitBreakerClient, json, "value");
        assertEquals(0.0, result, 0.0001);
    }

    @Test
    @DisplayName("synchronizeStates should call reportState for each local breaker without throwing")
    void testSynchronizeStates_NoException() throws Exception {
        distributedCircuitBreakerClient.getBreaker("svc1");
        distributedCircuitBreakerClient.getBreaker("svc2");

        Method syncMethod = DistributedCircuitBreakerClient.class.getDeclaredMethod("synchronizeStates");
        syncMethod.setAccessible(true);

        assertDoesNotThrow(() -> {
            try {
                syncMethod.invoke(distributedCircuitBreakerClient);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }
}