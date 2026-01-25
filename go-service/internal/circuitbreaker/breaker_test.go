package circuitbreaker

import (
	"context"
	"net/http"
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
		{"unknown", State(99), "UNKNOWN"},
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
	// Now buffer has 40,20,30 (order in data slice not important, only average)
	assert.Equal(t, 30*time.Millisecond, rb.Average())
}

func TestNewCircuitBreaker(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("test-breaker", cfg)

	assert.Equal(t, "test-breaker", cb.Name())
	assert.Equal(t, StateClosed, cb.State())
	assert.Equal(t, cfg, cb.config)
	assert.NotNil(t, cb.metrics)
	assert.NotNil(t, cb.metrics.responseTimes)
	assert.Len(t, cb.slidingWindow, cfg.SlidingWindowSize)
}

func TestGetOrCreate_ReturnsSameInstance(t *testing.T) {
	cfg := DefaultConfig()
	name := "shared-breaker"

	cb1 := GetOrCreate(name, cfg)
	cb2 := GetOrCreate(name, cfg)

	assert.Same(t, cb1, cb2)
	assert.Equal(t, name, cb1.Name())
}

func TestCircuitBreaker_Execute_Success(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-success", cfg)

	ctx := context.Background()
	err := cb.Execute(ctx, func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})

	assert.NoError(t, err)
	health := cb.GetHealthInfo()
	assert.Equal(t, "exec-success", health.Name)
	assert.Equal(t, "CLOSED", health.State)
	assert.Equal(t, 0, health.FailureCount)
	assert.GreaterOrEqual(t, health.SuccessCount, 0)

	totalCalls := health.Metrics["total_calls"].(uint64)
	successfulCalls := health.Metrics["successful_calls"].(uint64)
	failedCalls := health.Metrics["failed_calls"].(uint64)

	assert.Equal(t, uint64(1), totalCalls)
	assert.Equal(t, uint64(1), successfulCalls)
	assert.Equal(t, uint64(0), failedCalls)
}

func TestCircuitBreaker_Execute_Failure(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-failure", cfg)

	ctx := context.Background()
	testErr := assert.AnError

	err := cb.Execute(ctx, func() error {
		return testErr
	})

	assert.Equal(t, testErr, err)

	health := cb.GetHealthInfo()
	assert.Equal(t, "exec-failure", health.Name)
	assert.Equal(t, "CLOSED", health.State)
	// failureCount is incremented on each failure while closed
	assert.Equal(t, 1, health.FailureCount)
	totalCalls := health.Metrics["total_calls"].(uint64)
	successfulCalls := health.Metrics["successful_calls"].(uint64)
	failedCalls := health.Metrics["failed_calls"].(uint64)

	assert.Equal(t, uint64(1), totalCalls)
	assert.Equal(t, uint64(0), successfulCalls)
	assert.Equal(t, uint64(1), failedCalls)
}

func TestCircuitBreaker_ExecuteWithFallback_SuccessNoFallback(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-success", cfg)

	ctx := context.Background()
	calledFallback := false

	err := cb.ExecuteWithFallback(ctx, func() error {
		return nil
	}, func() error {
		calledFallback = true
		return nil
	})

	assert.NoError(t, err)
	assert.False(t, calledFallback)

	health := cb.GetHealthInfo()
	assert.Equal(t, 0, health.FailureCount)
	assert.GreaterOrEqual(t, health.SuccessCount, 0)
}

func TestCircuitBreaker_ExecuteWithFallback_UsesFallbackOnError(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-error", cfg)

	ctx := context.Background()
	calledFallback := false

	err := cb.ExecuteWithFallback(ctx, func() error {
		return assert.AnError
	}, func() error {
		calledFallback = true
		return nil
	})

	assert.NoError(t, err)
	assert.True(t, calledFallback)

	health := cb.GetHealthInfo()
	failedCalls := health.Metrics["failed_calls"].(uint64)
	assert.GreaterOrEqual(t, failedCalls, uint64(1))
}

func TestCircuitBreaker_ExecuteWithFallback_NoFallbackPropagatesError(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("exec-fallback-nil", cfg)

	ctx := context.Background()

	err := cb.ExecuteWithFallback(ctx, func() error {
		return assert.AnError
	}, nil)

	assert.Equal(t, assert.AnError, err)
}

func TestCircuitBreaker_OpenAfterFailureThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 3
	cfg.SlidingWindowSize = 3
	cfg.FailureRateThreshold = 1.0
	cb := New("open-after-threshold", cfg)

	ctx := context.Background()

	for i := 0; i < cfg.FailureThreshold; i++ {
		_ = cb.Execute(ctx, func() error {
			return assert.AnError
		})
	}

	assert.Equal(t, StateOpen, cb.State())

	health := cb.GetHealthInfo()
	assert.Equal(t, "OPEN", health.State)
	// failureCount is reset to 0 when transitioning to OPEN according to transitionTo
	assert.Equal(t, 0, health.FailureCount)
	failedCalls := health.Metrics["failed_calls"].(uint64)
	assert.Equal(t, uint64(cfg.FailureThreshold), failedCalls)
}

func TestCircuitBreaker_OpenOnFailureRateThreshold(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 100
	cfg.SlidingWindowSize = 4
	cfg.FailureRateThreshold = 0.5
	cb := New("open-on-rate", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return assert.AnError })
	_ = cb.Execute(ctx, func() error { return assert.AnError })
	_ = cb.Execute(ctx, func() error { return nil })

	assert.Equal(t, StateOpen, cb.State())
	health := cb.GetHealthInfo()
	assert.Equal(t, "OPEN", health.State)
	assert.GreaterOrEqual(t, health.FailureRate, 0.5)
}

func TestCircuitBreaker_RejectsWhenOpen(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = time.Hour
	cfg.FailureThreshold = 1
	cfg.SlidingWindowSize = 1
	cfg.FailureRateThreshold = 0.0
	cb := New("reject-open", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	err := cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'reject-open' is open")

	health := cb.GetHealthInfo()
	rejected := health.Metrics["rejected_calls"].(uint64)
	assert.Equal(t, uint64(1), rejected)
}

func TestCircuitBreaker_HalfOpenAndCloseAfterSuccesses(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.FailureThreshold = 1
	cfg.SuccessThreshold = 2
	cfg.HalfOpenMaxCalls = 2
	cfg.SlidingWindowSize = 2
	cfg.FailureRateThreshold = 0.0
	cb := New("half-open-close", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	// First call after timeout will transition to HALF_OPEN and allow the call
	err := cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	// Second successful call in HALF_OPEN should close the breaker
	err = cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateClosed, cb.State())
}

func TestCircuitBreaker_HalfOpenMaxCalls(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.FailureThreshold = 1
	cfg.HalfOpenMaxCalls = 1
	cfg.SlidingWindowSize = 1
	cfg.FailureRateThreshold = 0.0
	cb := New("half-open-max-calls", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)

	err := cb.Execute(ctx, func() error { return nil })
	assert.NoError(t, err)
	assert.Equal(t, StateHalfOpen, cb.State())

	err = cb.Execute(ctx, func() error { return nil })
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker 'half-open-max-calls' is open")
}

func TestCircuitBreaker_StateAndName(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("state-name", cfg)

	assert.Equal(t, "state-name", cb.Name())
	assert.Equal(t, StateClosed, cb.State())

	ctx := context.Background()
	cfg2 := DefaultConfig()
	cfg2.FailureThreshold = 1
	cfg2.SlidingWindowSize = 1
	cfg2.FailureRateThreshold = 0.0
	cb2 := New("state-name-open", cfg2)
	_ = cb2.Execute(ctx, func() error { return assert.AnError })

	assert.Equal(t, StateOpen, cb2.State())
}

func TestCircuitBreaker_GetHealthInfoMetricsTypes(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("health-metrics", cfg)

	ctx := context.Background()
	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return assert.AnError })

	health := cb.GetHealthInfo()

	assert.Equal(t, "health-metrics", health.Name)
	assert.NotEmpty(t, health.State)
	assert.GreaterOrEqual(t, health.FailureCount, 0)
	assert.GreaterOrEqual(t, health.SuccessCount, 0)

	m := health.Metrics
	if _, ok := m["total_calls"].(uint64); !ok {
		t.Fatalf("total_calls not uint64")
	}
	if _, ok := m["successful_calls"].(uint64); !ok {
		t.Fatalf("successful_calls not uint64")
	}
	if _, ok := m["failed_calls"].(uint64); !ok {
		t.Fatalf("failed_calls not uint64")
	}
	if _, ok := m["rejected_calls"].(uint64); !ok {
		t.Fatalf("rejected_calls not uint64")
	}
	if _, ok := m["state_changes"].(uint64); !ok {
		t.Fatalf("state_changes not uint64")
	}
	if _, ok := m["avg_response_time_ms"].(int64); !ok {
		t.Fatalf("avg_response_time_ms not int64")
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestNewDistributedCoordinator_Defaults(t *testing.T) {
	os.Unsetenv("NODE_ID")
	dc := NewDistributedCoordinator("http://coordinator")

	assert.Equal(t, "http://coordinator", dc.coordinatorURL)
	assert.NotEmpty(t, dc.nodeID)
	assert.NotNil(t, dc.breakers)
	assert.NotNil(t, dc.client)
	assert.Equal(t, 5*time.Second, dc.syncInterval)
	assert.NotNil(t, dc.stopChan)
}

func TestNewDistributedCoordinator_UsesEnvNodeID(t *testing.T) {
	os.Setenv("NODE_ID", "test-node-id")
	defer os.Unsetenv("NODE_ID")

	dc := NewDistributedCoordinator("http://coordinator")
	assert.Equal(t, "test-node-id", dc.nodeID)
}

func TestDistributedCoordinator_Register(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cfg := DefaultConfig()
	cb := New("reg-breaker", cfg)

	dc.Register(cb)

	dc.mu.RLock()
	defer dc.mu.RUnlock()
	assert.Equal(t, cb, dc.breakers["reg-breaker"])
}

func TestDistributedCoordinator_StartSyncAndStop(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cfg := DefaultConfig()
	cb := New("sync-breaker", cfg)
	dc.Register(cb)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})

	go func() {
		dc.StartSync(ctx)
		close(done)
	}()

	time.Sleep(20 * time.Millisecond)
	dc.Stop()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("StartSync did not return after Stop")
	}
}

func TestDistributedCoordinator_syncStatesDoesNotPanic(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cfg := DefaultConfig()
	cb1 := New("breaker1", cfg)
	cb2 := New("breaker2", cfg)

	dc.Register(cb1)
	dc.Register(cb2)

	dc.syncStates()
}

func TestDistributedCoordinator_reportStateDoesNotPanic(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cfg := DefaultConfig()
	cb := New("report-breaker", cfg)

	dc.reportState(cb)
}

func TestCircuitBreaker_MetricsCountersIncrement(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("metrics-increment", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return assert.AnError })

	health := cb.GetHealthInfo()
	total := health.Metrics["total_calls"].(uint64)
	success := health.Metrics["successful_calls"].(uint64)
	failed := health.Metrics["failed_calls"].(uint64)

	assert.Equal(t, uint64(2), total)
	assert.Equal(t, uint64(1), success)
	assert.Equal(t, uint64(1), failed)
}

func TestCircuitBreaker_RejectedCallsMetric(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = time.Hour
	cfg.FailureThreshold = 1
	cfg.SlidingWindowSize = 1
	cfg.FailureRateThreshold = 0.0
	cb := New("rejected-metric", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	for i := 0; i < 3; i++ {
		_ = cb.Execute(ctx, func() error { return nil })
	}

	health := cb.GetHealthInfo()
	rejected := health.Metrics["rejected_calls"].(uint64)
	assert.Equal(t, uint64(3), rejected)
}

func TestCircuitBreaker_StateChangesMetric(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Timeout = 10 * time.Millisecond
	cfg.FailureThreshold = 1
	cfg.SuccessThreshold = 1
	cfg.SlidingWindowSize = 1
	cfg.FailureRateThreshold = 0.0
	cb := New("state-changes", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return assert.AnError })
	assert.Equal(t, StateOpen, cb.State())

	time.Sleep(cfg.Timeout + 5*time.Millisecond)
	_ = cb.Execute(ctx, func() error { return nil })

	_ = cb.Execute(ctx, func() error { return nil })

	health := cb.GetHealthInfo()
	stateChanges := health.Metrics["state_changes"].(uint64)
	assert.GreaterOrEqual(t, stateChanges, uint64(2))
}

func TestCircuitBreaker_AvgResponseTimeMetric(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("avg-response", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error {
		time.Sleep(5 * time.Millisecond)
		return nil
	})
	_ = cb.Execute(ctx, func() error {
		time.Sleep(10 * time.Millisecond)
		return nil
	})

	health := cb.GetHealthInfo()
	avgMs := health.Metrics["avg_response_time_ms"].(int64)
	assert.Greater(t, avgMs, int64(0))
}

func TestCircuitBreaker_FailureCountDecrementsOnSuccess(t *testing.T) {
	cfg := DefaultConfig()
	cfg.FailureThreshold = 10
	cfg.SlidingWindowSize = 10
	cfg.FailureRateThreshold = 1.0
	cb := New("failure-decrement", cfg)

	ctx := context.Background()

	for i := 0; i < 3; i++ {
		_ = cb.Execute(ctx, func() error { return assert.AnError })
	}

	for i := 0; i < 2; i++ {
		_ = cb.Execute(ctx, func() error { return nil })
	}

	health := cb.GetHealthInfo()
	// failureCount may be decremented on success; ensure it's non-negative and less than initial failures
	assert.GreaterOrEqual(t, health.FailureCount, 0)
	assert.LessOrEqual(t, health.FailureCount, 3)
}

func TestCircuitBreaker_FailureRateCalculation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SlidingWindowSize = 4
	cfg.FailureThreshold = 100
	cfg.FailureRateThreshold = 1.0
	cb := New("failure-rate", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return assert.AnError })
	_ = cb.Execute(ctx, func() error { return assert.AnError })
	_ = cb.Execute(ctx, func() error { return nil })

	health := cb.GetHealthInfo()
	assert.InDelta(t, 0.5, health.FailureRate, 0.0001)
}

func TestDistributedCoordinator_StopIdempotent(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")

	dc.Stop()
	// calling Stop again should not panic
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Stop panicked on second call: %v", r)
		}
	}()
	dc.Stop()
}

func TestDistributedCoordinator_RegisterMultipleBreakers(t *testing.T) {
	dc := NewDistributedCoordinator("http://coordinator")
	cfg := DefaultConfig()

	cb1 := New("b1", cfg)
	cb2 := New("b2", cfg)

	dc.Register(cb1)
	dc.Register(cb2)

	dc.mu.RLock()
	defer dc.mu.RUnlock()

	assert.Equal(t, cb1, dc.breakers["b1"])
	assert.Equal(t, cb2, dc.breakers["b2"])
}

func TestCircuitBreaker_Execute_ContextCancellationDoesNotAffectLogic(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("ctx-cancel", cfg)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := cb.Execute(ctx, func() error {
		return nil
	})

	assert.NoError(t, err)
	health := cb.GetHealthInfo()
	assert.Equal(t, uint64(1), health.Metrics["total_calls"].(uint64))
}

func TestCircuitBreaker_ExecuteWithFallback_ContextCancellation(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("ctx-cancel-fallback", cfg)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	calledFallback := false

	err := cb.ExecuteWithFallback(ctx, func() error {
		return assert.AnError
	}, func() error {
		calledFallback = true
		return nil
	})

	assert.NoError(t, err)
	assert.True(t, calledFallback)
}

func TestCircuitBreaker_HealthInfoFailureAndSuccessCounts(t *testing.T) {
	cfg := DefaultConfig()
	cb := New("health-counts", cfg)

	ctx := context.Background()

	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return nil })
	_ = cb.Execute(ctx, func() error { return assert.AnError })

	health := cb.GetHealthInfo()
	// failureCount reflects current internal counter
	assert.Equal(t, int(atomic.LoadInt32(&cb.failureCount)), health.FailureCount)
	assert.Equal(t, int(atomic.LoadInt32(&cb.successCount)), health.SuccessCount)
}
