package com.polyglot.circuitbreaker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class DistributedCircuitBreakerClient {
    
    private final HttpClient httpClient;
    private final String coordinatorUrl;
    private final Map<String, CircuitBreaker<Object>> localBreakers;
    private final Duration syncInterval;
    private volatile boolean running = true;
    
    public DistributedCircuitBreakerClient(String coordinatorUrl) {
        this.coordinatorUrl = coordinatorUrl;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
        this.localBreakers = new ConcurrentHashMap<>();
        this.syncInterval = Duration.ofSeconds(5);
        startSyncThread();
    }
    
    public CircuitBreaker<Object> getBreaker(String serviceName) {
        return localBreakers.computeIfAbsent(serviceName, name -> {
            CircuitBreaker<Object> breaker = CircuitBreaker.create(name);
            registerWithCoordinator(name);
            return breaker;
        });
    }
    
    private void registerWithCoordinator(String serviceName) {
        try {
            String json = String.format(
                "{\"service\":\"%s\",\"node_id\":\"%s\",\"failure_threshold\":5,\"success_threshold\":3}",
                serviceName, getNodeId()
            );
            
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(coordinatorUrl + "/circuit-breakers/register"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
            
            httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            System.err.println("Failed to register with coordinator: " + e.getMessage());
        }
    }
    
    public void reportState(String serviceName, CircuitBreaker.State state, int failureCount) {
        try {
            String json = String.format(
                "{\"service\":\"%s\",\"node_id\":\"%s\",\"state\":\"%s\",\"failure_count\":%d,\"timestamp\":%d}",
                serviceName, getNodeId(), state.name(), failureCount, System.currentTimeMillis()
            );
            
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(coordinatorUrl + "/circuit-breakers/state"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
            
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            System.err.println("Failed to report state: " + e.getMessage());
        }
    }
    
    public AggregatedState getAggregatedState(String serviceName) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(coordinatorUrl + "/circuit-breakers/" + serviceName + "/aggregate"))
                .GET()
                .build();
            
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            return parseAggregatedState(response.body());
        } catch (Exception e) {
            return new AggregatedState(serviceName, "UNKNOWN", 0, 0.0);
        }
    }
    
    private AggregatedState parseAggregatedState(String json) {
        String service = extractJsonString(json, "service");
        String consensusState = extractJsonString(json, "consensus_state");
        int totalNodes = extractJsonInt(json, "total_nodes");
        double healthScore = extractJsonDouble(json, "health_score");
        return new AggregatedState(service, consensusState, totalNodes, healthScore);
    }
    
    private String extractJsonString(String json, String key) {
        int start = json.indexOf("\"" + key + "\":\"") + key.length() + 4;
        int end = json.indexOf("\"", start);
        return start > key.length() + 3 && end > start ? json.substring(start, end) : "";
    }
    
    private int extractJsonInt(String json, String key) {
        try {
            int start = json.indexOf("\"" + key + "\":") + key.length() + 3;
            int end = start;
            while (end < json.length() && Character.isDigit(json.charAt(end))) end++;
            return Integer.parseInt(json.substring(start, end));
        } catch (Exception e) {
            return 0;
        }
    }
    
    private double extractJsonDouble(String json, String key) {
        try {
            int start = json.indexOf("\"" + key + "\":") + key.length() + 3;
            int end = start;
            while (end < json.length() && (Character.isDigit(json.charAt(end)) || json.charAt(end) == '.')) end++;
            return Double.parseDouble(json.substring(start, end));
        } catch (Exception e) {
            return 0.0;
        }
    }
    
    private void startSyncThread() {
        Thread syncThread = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(syncInterval.toMillis());
                    synchronizeStates();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "circuit-breaker-sync");
        syncThread.setDaemon(true);
        syncThread.start();
    }
    
    private void synchronizeStates() {
        for (Map.Entry<String, CircuitBreaker<Object>> entry : localBreakers.entrySet()) {
            CircuitBreaker<Object> breaker = entry.getValue();
            reportState(entry.getKey(), breaker.getState(), breaker.getFailureCount());
        }
    }
    
    public void shutdown() {
        running = false;
    }
    
    private String getNodeId() {
        return System.getenv().getOrDefault("NODE_ID", 
            "java-" + ProcessHandle.current().pid());
    }
    
    public record AggregatedState(String service, String consensusState, int totalNodes, double healthScore) {}
}
