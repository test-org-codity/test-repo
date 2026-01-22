package circuitbreaker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestState_String(t *testing.T) {
	tests := []struct {
		name string
		s    State
		want string
	}{
		{"closed", StateClosed, "CLOSED"},
		{"open", StateOpen, "OPEN"},
		{"half_open", StateHalfOpen, "HALF_OPEN"},
		{"unknown", State(999), "UNKNOWN"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, tt.s.String())
		})
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	assert.Equal(t, 5, cfg.FailureThreshold)
	assert.Equal(t, 3, cfg.SuccessThreshold)
	assert.Equal(t, 30*time.Second, cfg.Timeout)
	assert.Equal(t, 3, cfg.HalfOpenMaxCalls)
	assert.Equal(t, 10, cfg.SlidingWindowSize)
	assert.Equal(t, 0.5, cfg.FailureRateThreshold)
}

func TestNewRingBuffer_AddAndAverage(t *testing.T) {
	rb := NewRingBuffer(3)

	assert.Equal(t, time.Duration(0), rb.Average())

	rb.Add(10 * time.Millisecond)
	assert.Equal(t, 10*time.Millisecond, rb.Average())

	rb.Add(20 * time.Millisecond)
	assert.Equal(t, 15*time.Millisecond, rb.Average())

	rb.Add(30 * time.Millisecond)
	assert.Equal(t, 20*time.Millisecond, rb.Average())

	// Overwrite oldest
	rb.Add(40 * time.Millisecond)
	// Now buffer has 40,20,30 (order not important for average)
	assert.Equal(t, (40+20+30)/3*time.Millisecond, rb.Average())
}

func TestNewCircuitBreaker_InitialState(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test", cfg)

	assert.Equal(t, "test", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "shared"

	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)

	assert.Same(t, cb1, cb2)
}

func TestCircuitBreaker_Execute_SuccessClosed(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	ctx := context.Background()
	called := false

	err := cb.Execute(ctx, func() error {
		called = true
		return nil
	})

	assert.NoError(t, err)
	assert.True(t, called)
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.FailedCalls))
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_Execute_FailureClosedToOpenByFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100 // high so rate triggers first
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("exec-fail-rate", cfg)

	ctx := context.Background()

	// 3 failures, 1 success => 75% failure rate
	for i := 0; i < 3; i++ {
		_ = cb.Execute(ctx, func() error { return assert.AnError })
	}
	_ = cb.Execute(ctx, func() error { return nil })

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_Execute_OpenRejects(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-open", cfg)

	// Force open
	cb.transitionTo(StateOpen)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'exec-open' is open")
	assert.Equal(t, uint64(0), atomic.LoadUint64(&cb.metrics.TotalCalls))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.RejectedCalls))
}

func TestCircuitBreaker_ExecuteWithFallback_PrimarySuccess(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-success", cfg)

	ctx := context.Background()
	primaryCalled := false
	fallbackCalled := false

	err := cb.ExecuteWithFallback(ctx,
		func() error {
			primaryCalled = true
			return nil
		},
		func() error {
			fallbackCalled = true
			return nil
		},
	)

	assert.NoError(t, err)
	assert.True(t, primaryCalled)
	assert.False(t, fallbackCalled)
}

func TestCircuitBreaker_ExecuteWithFallback_PrimaryFailsFallbackCalled(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-fail", cfg)

	ctx := context.Background()
	primaryCalled := false
	fallbackCalled := false

	err := cb.ExecuteWithFallback(ctx,
		func() error {
			primaryCalled = true
			return assert.AnError
		},
		func() error {
			fallbackCalled = true
			return nil
		},
	)

	assert.NoError(t, err)
	assert.True(t, primaryCalled)
	assert.True(t, fallbackCalled)
}

func TestCircuitBreaker_ExecuteWithFallback_NoFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-nil", cfg)

	ctx := context.Background()
	primaryCalled := false

	err := cb.ExecuteWithFallback(ctx,
		func() error {
			primaryCalled = true
			return assert.AnError
		},
		nil,
	)

	assert.Error(t, err)
	assert.True(t, primaryCalled)
}

func TestCircuitBreaker_allowRequest_ClosedAlwaysAllows(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("allow-closed", cfg)

	cb.transitionTo(StateClosed)
	assert.True(t, cb.allowRequest())
}

func TestCircuitBreaker_allowRequest_OpenBlocksUntilTimeout(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 50 * time.Millisecond
	cb := New("allow-open", cfg)

	cb.transitionTo(StateOpen)
	cb.openedAt.Store(time.Now())

	assert.False(t, cb.allowRequest())

	time.Sleep(cfg.Timeout + 10*time.Millisecond)
	assert.True(t, cb.allowRequest())
	assert.Equal(t, StateHalfOpen, cb.State())
}

func TestCircuitBreaker_allowRequest_HalfOpenMaxCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HalfOpenMaxCalls = 2
	cb := New("allow-half-open", cfg)

	cb.transitionTo(StateHalfOpen)

	// First two allowed
	assert.True(t, cb.allowRequest())
	assert.True(t, cb.allowRequest())
	// Third should be rejected
	assert.False(t, cb.allowRequest())
}

func TestCircuitBreaker_shouldAttemptReset(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 20 * time.Millisecond
	cb := New("reset", cfg)

	// No openedAt set
	assert.False(t, cb.shouldAttemptReset())

	// Set openedAt in the future (i.e., now, so not yet timed out)
	cb.openedAt.Store(time.Now())
	assert.False(t, cb.shouldAttemptReset())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)
	assert.True(t, cb.shouldAttemptReset())
}

func TestCircuitBreaker_recordSuccess_ClosedDecrementsFailures(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("success-closed", cfg)

	atomic.StoreInt32(&cb.failureCount, 2)

	cb.recordSuccess(10 * time.Millisecond)

	assert.Equal(t, int32(1), atomic.LoadInt32(&cb.failureCount))
	assert.Equal(t, uint64(1), atomic.LoadUint64(&cb.metrics.SuccessfulCalls))
	assert.WithinDuration(t, time.Now(), cb.metrics.LastSuccess, time.Second)
}

func TestCircuitBreaker_recordSuccess_HalfOpenClosesAfterThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SuccessThreshold = 2
	cb := New("success-half-open", cfg)

	cb.transitionTo(StateHalfOpen)

	cb.recordSuccess(10 * time.Millisecond)
	assert.Equal(t, StateHalfOpen, cb.State())

	cb.recordSuccess(10 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_recordFailure_ClosedOpensOnThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 2
	cfg.FailureRateThreshold = 1.0
	cb := New("failure-closed", cfg)

	cb.transitionTo(StateClosed)

	cb.recordFailure(10 * time.Millisecond)
	assert.Equal(t, StateClosed, cb.State())

	cb.recordFailure(10 * time.Millisecond)
	assert.Equal(t, StateOpen, cb.State())
	assert.WithinDuration(t, time.Now(), cb.metrics.LastFailure, time.Second)
}

func TestCircuitBreaker_recordFailure_HalfOpenGoesOpen(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("failure-half-open", cfg)

	cb.transitionTo(StateHalfOpen)
	cb.recordFailure(10 * time.Millisecond)

	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_addToSlidingWindowAndCalculateFailureRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("window", cfg)

	cb.addToSlidingWindow(true)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(true)

	rate := cb.calculateFailureRate()
	assert.InDelta(t, 0.5, rate, 0.0001)

	// Overwrite oldest
	cb.addToSlidingWindow(false)
	// Now window has: false, false, true, false => 3/4 failures
	rate = cb.calculateFailureRate()
	assert.InDelta(t, 0.75, rate, 0.0001)
}

func TestCircuitBreaker_clearSlidingWindow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 3
	cb := New("clear-window", cfg)

	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)
	cb.addToSlidingWindow(false)

	cb.clearSlidingWindow()
	for _, v := range cb.slidingWindow {
		assert.True(t, v)
	}
	assert.Equal(t, 0, cb.windowIndex)
}

func TestCircuitBreaker_StateAndName(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("state-name", cfg)

	assert.Equal(t, "state-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	cb.transitionTo(StateOpen)
	assert.Equal(t, StateOpen, cb.State())
}

func TestCircuitBreaker_GetHealthInfo(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cb := New("health", cfg)

	// Simulate some calls
	cb.recordFailure(10 * time.Millisecond)
	cb.recordSuccess(20 * time.Millisecond)
	cb.recordFailure(30 * time.Millisecond)
	cb.recordSuccess(40 * time.Millisecond)

	atomic.AddUint64(&cb.metrics.TotalCalls, 4)
	atomic.AddUint64(&cb.metrics.RejectedCalls, 1)
	atomic.AddUint64(&cb.metrics.StateChanges, 2)

	info := cb.GetHealthInfo()

	assert.Equal(t, "health", info.Name)
	assert.Equal(t, cb.State().String(), info.State)
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), info.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), info.SuccessCount)
	assert.InDelta(t, cb.calculateFailureRate(), info.FailureRate, 0.0001)

	metrics := info.Metrics
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.TotalCalls), metrics["total_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.SuccessfulCalls), metrics["successful_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.FailedCalls), metrics["failed_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.RejectedCalls), metrics["rejected_calls"])
	assert.Equal(t, atomic.LoadUint64(&cb.metrics.StateChanges), metrics["state_changes"])
	_, ok := metrics["avg_response_time_ms"]
	assert.True(t, ok)
}

func TestNewDistributedCoordinator_Defaults(t *testing.T) {
	// Ensure NODE_ID is unset for this test
	_ = os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")

	assert.Equal(t, "http://coordinator", dc.coordinatorURL)
	assert.NotEmpty(t, dc.nodeID)
	assert.Contains(t, dc.nodeID, "go-")
	assert.NotNil(t, dc.breakers)
	assert.NotNil(t, dc.client)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
	assert.NotNil(t, dc.stopChan)
}

func TestNewDistributedCoordinator_UsesEnvNodeID(t *testing.T) {
	_ = os.Setenv("NODE_ID", "node-123")
	defer os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")
	assert.Equal(t, "node-123", dc.nodeID)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cb := New("service-a", DefaultConfig())

	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Equal(t, cb, dc.breakers["service-a"])
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")

	// Replace client with a test server to avoid real HTTP calls
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dc.coordinatorURL = server.URL
	dc.syncInterval = 10 * time.Millisecond

	cb := New("service-sync", DefaultConfig())
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go dc.StartSync(ctx)

	// Let it run a couple of ticks
	time.Sleep(30 * time.Millisecond)

	// Stop via Stop()
	dc.Stop()

	// Give some time to exit
	time.Sleep(20 * time.Millisecond)
}

func TestDistributedCoordinator_syncStatesAndReportState(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")

	var received int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/circuit-breakers/state" && r.Method == http.MethodPost {
			atomic.AddInt32(&received, 1)
			var payload map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dc.coordinatorURL = server.URL

	cb1 := New("svc1", DefaultConfig())
	cb2 := New("svc2", DefaultConfig())
	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()

	assert.Equal(t, int32(2), atomic.LoadInt32(&received))
}
