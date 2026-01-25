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

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("DistributedCircuitBreakerClient Tests")
class DistributedCircuitBreakerClientTest {

    private DistributedCircuitBreakerClient distributedCircuitBreakerClient;

    @BeforeEach
    void setUp() {
        // Use a dummy URL; we won't actually hit a real coordinator in these tests
        distributedCircuitBreakerClient = new DistributedCircuitBreakerClient("http://localhost:9999");
    }

    @AfterEach
    void tearDown() {
        if (distributedCircuitBreakerClient != null) {
            distributedCircuitBreakerClient.shutdown();
        }
        distributedCircuitBreakerClient = null;
    }

    @Test
    @DisplayName("Constructor should create instance and initialize internal fields")
    void testConstructor() throws Exception {
        assertNotNull(distributedCircuitBreakerClient);

        // Verify coordinatorUrl is set
        Field coordinatorUrlField = DistributedCircuitBreakerClient.class.getDeclaredField("coordinatorUrl");
        coordinatorUrlField.setAccessible(true);
        Object url = coordinatorUrlField.get(distributedCircuitBreakerClient);
        assertEquals("http://localhost:9999", url);

        // Verify httpClient is initialized
        Field httpClientField = DistributedCircuitBreakerClient.class.getDeclaredField("httpClient");
        httpClientField.setAccessible(true);
        Object httpClient = httpClientField.get(distributedCircuitBreakerClient);
        assertNotNull(httpClient);
        assertTrue(httpClient instanceof HttpClient);

        // Verify localBreakers map is initialized
        Field localBreakersField = DistributedCircuitBreakerClient.class.getDeclaredField("localBreakers");
        localBreakersField.setAccessible(true);
        Object localBreakers = localBreakersField.get(distributedCircuitBreakerClient);
        assertNotNull(localBreakers);
    }

    @Test
    @DisplayName("getBreaker should create a new breaker for a new service name")
    void testGetBreakerCreatesNew() {
        CircuitBreaker<Object> breaker = distributedCircuitBreakerClient.getBreaker("serviceA");
        assertNotNull(breaker);
        assertEquals("serviceA", breaker.getName());
    }

    @Test
    @DisplayName("getBreaker should return same instance for same service name")
    void testGetBreakerReturnsSameInstance() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceB");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceB");
        assertSame(breaker1, breaker2);
    }

    @Test
    @DisplayName("getBreaker should create different instances for different service names")
    void testGetBreakerDifferentServices() {
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("serviceC1");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("serviceC2");
        assertNotSame(breaker1, breaker2);
        assertEquals("serviceC1", breaker1.getName());
        assertEquals("serviceC2", breaker2.getName());
    }

    @Test
    @DisplayName("reportState should not throw exceptions for normal input")
    void testReportStateNoException() {
        // Just ensure no exception is thrown; network failures are swallowed by implementation
        distributedCircuitBreakerClient.reportState("serviceD", CircuitBreaker.State.CLOSED, 0);
    }

    @Test
    @DisplayName("getAggregatedState should return UNKNOWN state on coordinator error or invalid JSON")
    void testGetAggregatedStateUnknownOnError() {
        // Using dummy URL; send() will likely fail and method should return UNKNOWN AggregatedState
        AggregatedState state = distributedCircuitBreakerClient.getAggregatedState("serviceE");
        assertNotNull(state);
        assertEquals("serviceE", state.service());
        assertEquals("UNKNOWN", state.consensusState());
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("parseAggregatedState should correctly parse valid JSON")
    void testParseAggregatedStateValidJson() throws Exception {
        String json = "{\"service\":\"payments\",\"consensus_state\":\"OPEN\",\"total_nodes\":5,\"health_score\":0.75}";

        Method parseMethod = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("parseAggregatedState", String.class);
        parseMethod.setAccessible(true);

        AggregatedState state = (AggregatedState) parseMethod.invoke(distributedCircuitBreakerClient, json);

        assertNotNull(state);
        assertEquals("payments", state.service());
        assertEquals("OPEN", state.consensusState());
        assertEquals(5, state.totalNodes());
        assertEquals(0.75, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("parseAggregatedState should handle missing or malformed fields gracefully")
    void testParseAggregatedStateMalformedJson() throws Exception {
        String json = "{\"serviceX\":\"wrongKey\",\"consensus_state\":\"CLOSED\",\"total_nodes\":\"NaN\",\"health_score\":\"bad\"}";

        Method parseMethod = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("parseAggregatedState", String.class);
        parseMethod.setAccessible(true);

        AggregatedState state = (AggregatedState) parseMethod.invoke(distributedCircuitBreakerClient, json);

        assertNotNull(state);
        // service key is missing, extractJsonString should return empty string
        assertEquals("", state.service());
        assertEquals("CLOSED", state.consensusState());
        // malformed numbers should be parsed as 0 / 0.0
        assertEquals(0, state.totalNodes());
        assertEquals(0.0, state.healthScore(), 0.0001);
    }

    @Test
    @DisplayName("extractJsonString should return empty string when key not found")
    void testExtractJsonStringKeyNotFound() throws Exception {
        String json = "{\"other\":\"value\"}";

        Method extractString = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("extractJsonString", String.class, String.class);
        extractString.setAccessible(true);

        String result = (String) extractString.invoke(distributedCircuitBreakerClient, json, "missing");
        assertEquals("", result);
    }

    @Test
    @DisplayName("extractJsonInt should parse integer value correctly")
    void testExtractJsonIntValid() throws Exception {
        String json = "{\"total_nodes\":123}";

        Method extractInt = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("extractJsonInt", String.class, String.class);
        extractInt.setAccessible(true);

        int result = (int) extractInt.invoke(distributedCircuitBreakerClient, json, "total_nodes");
        assertEquals(123, result);
    }

    @Test
    @DisplayName("extractJsonInt should return 0 on malformed or missing value")
    void testExtractJsonIntMalformedOrMissing() throws Exception {
        String jsonMalformed = "{\"total_nodes\":\"abc\"}";
        String jsonMissing = "{\"other\":10}";

        Method extractInt = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("extractJsonInt", String.class, String.class);
        extractInt.setAccessible(true);

        int malformed = (int) extractInt.invoke(distributedCircuitBreakerClient, jsonMalformed, "total_nodes");
        int missing = (int) extractInt.invoke(distributedCircuitBreakerClient, jsonMissing, "total_nodes");

        assertEquals(0, malformed);
        assertEquals(0, missing);
    }

    @Test
    @DisplayName("extractJsonDouble should parse double value correctly")
    void testExtractJsonDoubleValid() throws Exception {
        String json = "{\"health_score\":0.987}";

        Method extractDouble = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("extractJsonDouble", String.class, String.class);
        extractDouble.setAccessible(true);

        double result = (double) extractDouble.invoke(distributedCircuitBreakerClient, json, "health_score");
        assertEquals(0.987, result, 0.0001);
    }

    @Test
    @DisplayName("extractJsonDouble should return 0.0 on malformed or missing value")
    void testExtractJsonDoubleMalformedOrMissing() throws Exception {
        String jsonMalformed = "{\"health_score\":\"bad\"}";
        String jsonMissing = "{\"other\":1.23}";

        Method extractDouble = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("extractJsonDouble", String.class, String.class);
        extractDouble.setAccessible(true);

        double malformed = (double) extractDouble.invoke(distributedCircuitBreakerClient, jsonMalformed, "health_score");
        double missing = (double) extractDouble.invoke(distributedCircuitBreakerClient, jsonMissing, "health_score");

        assertEquals(0.0, malformed, 0.0001);
        assertEquals(0.0, missing, 0.0001);
    }

    @Test
    @DisplayName("synchronizeStates should call reportState for each local breaker without throwing")
    void testSynchronizeStates() throws Exception {
        // Create a couple of breakers
        CircuitBreaker<Object> breaker1 = distributedCircuitBreakerClient.getBreaker("syncService1");
        CircuitBreaker<Object> breaker2 = distributedCircuitBreakerClient.getBreaker("syncService2");

        // Change their state to ensure non-default values are handled
        breaker1.recordFailure(new RuntimeException("fail1"));
        breaker2.recordFailure(new RuntimeException("fail2"));

        Method syncMethod = DistributedCircuitBreakerClient.class
                .getDeclaredMethod("synchronizeStates");
        syncMethod.setAccessible(true);

        // Just ensure no exception is thrown when synchronizing
        syncMethod.invoke(distributedCircuitBreakerClient);
    }

    @Test
    @DisplayName("shutdown should stop sync thread by setting running to false")
    void testShutdownSetsRunningFalse() throws Exception {
        Field runningField = DistributedCircuitBreakerClient.class.getDeclaredField("running");
        runningField.setAccessible(true);

        // Initially should be true
        boolean runningBefore = (boolean) runningField.get(distributedCircuitBreakerClient);
        assertTrue(runningBefore);

        distributedCircuitBreakerClient.shutdown();

        boolean runningAfter = (boolean) runningField.get(distributedCircuitBreakerClient);
        assertFalse(runningAfter);
    }

    @Test
    @DisplayName("AggregatedState record should expose its fields correctly")
    void testAggregatedStateRecord() {
        AggregatedState state = new AggregatedState("svc", "CLOSED", 3, 0.5);
        assertEquals("svc", state.service());
        assertEquals("CLOSED", state.consensusState());
        assertEquals(3, state.totalNodes());
        assertEquals(0.5, state.healthScore(), 0.0001);
    }
}